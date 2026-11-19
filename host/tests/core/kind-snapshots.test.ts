import { afterEach, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { Host } from '../../src/core/host'
import type { CorePlugin } from '../../src/core/plugin'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { tempDir } from '../helpers/helpers'

// 普通动态定义器，故意不用 fields/template/tpl:，验证核心按公共来源标记回收。
const plugin: CorePlugin = {
  id: 'dynamic-test', version: 1,
  blocks: [{ id: 'dynamic-test-schema', plugin: 'dynamic-test', title: '结构', version: 1, rebuildable: false, standalone: true, management: {}, fields: { title: { type: 'text', title: '名称' } } }],
  defines: { kind: 'dynamic-test-schema', prefix: 'dynamic-test:', build: (id, data) => ({
    id: `dynamic-test:${id}`, template: id, plugin: 'dynamic-test', title: String(data.title), version: 1, rebuildable: false,
    fields: { value: { type: 'text', title: '值', search: true } }
  }) },
  commands: {
    drop(ctx, { source, item, fail }) {
      // 先删来源、后清使用者，回收必须等事务最终状态，不能只跟随定义器变更。
      ctx.deleteRecord(String(source))
      if (item) ctx.remove(String(item), `dynamic-test:${source}`)
      if (fail) throw new Error('模拟业务失败')
      return { label: '删除结构' }
    },
    transient(ctx) {
      const source = ctx.createEntity()
      ctx.put(source, 'dynamic-test-schema', { title: '临时结构' })
      ctx.deleteRecord(source)
      return { label: '临时结构', result: source }
    }
  }
}
let host: Host | undefined, root: string | undefined
const events: string[] = []
const open = (enabled = true) => {
  host?.close()
  root ??= tempDir('rm-kind-snapshots-')
  host = new Host(root, enabled ? [...corePlugins, plugin] : corePlugins, event => { events.push(event) }, {
    manifest: enabled ? [...PLUGINS, { id: plugin.id, title: '动态定义测试', description: '' }] : PLUGINS
  })
  return host
}
afterEach(async () => { await host?.scheduler.idle(); host?.close(); host = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; events.length = 0 })
const snapshot = (id: string) => host!.lib.db.prepare('SELECT def FROM main.kind_def WHERE id = ?').pluck().get(id)
const make = (h: Host) => {
  const source = h.api.create({ 'dynamic-test-schema': { title: '自定义结构' } }) as string
  const kind = `dynamic-test:${source}`
  const item = h.api.create({ text: { content: '保留正文' }, [kind]: { value: '保留字段' } }) as string
  return { source, kind, item }
}

it('预演与失败不清快照；删除后立即回收，反复撤销重做恢复定义和值', async () => {
  const h = open(), { source, kind, item } = make(h), before = snapshot(kind)
  h.api.preview(plugin.id, 'drop', { source, item })
  expect(snapshot(kind)).toBe(before)
  expect(() => h.api.run(plugin.id, 'drop', { source, item, fail: true })).toThrow('模拟业务失败')
  expect(snapshot(kind)).toBe(before)
  expect(h.reg.kind(kind)).toBeDefined()
  expect(h.store.blocksOf(item)[kind].data.value).toBe('保留字段')
  h.api.run(plugin.id, 'drop', { source, item })
  for (let i = 0; i < 3; i++) {
    expect(snapshot(kind)).toBeUndefined()
    expect(h.reg.kind(kind)).toBeUndefined()
    expect((await h.api.describeLibrary()).kinds.some(k => k.id === kind)).toBe(false)
    h.api.undo()
    expect(snapshot(kind)).toBe(before)
    expect(h.store.blocksOf(item)[kind].data.value).toBe('保留字段')
    expect((await h.api.query({ search: [{ kind, text: '保留字段' }] })).ids).toEqual([item])
    h.api.redo()
  }
  expect(h.lib.db.prepare('SELECT count(*) FROM main.block_history WHERE kind = ?').pluck().get(kind)).toBeGreaterThan(0)
  expect(h.store.blocksOf(item).text.data.content).toBe('保留正文')
})

it('回收发生在事务末尾：中途删除来源再恢复，不提前释放快照', () => {
  const h = open(), { source, kind, item } = make(h), before = snapshot(kind), record = h.store.blocksOf(source)['dynamic-test-schema'].data
  const created = h.store.get([source])[0].createdAt
  h.store.batch(() => {
    h.store.remove(item, kind)
    h.store.purge([source])
    expect(snapshot(kind)).toBe(before)
    h.store.restoreIdentity(source, created, null)
    h.store.put(source, 'dynamic-test-schema', record)
  })
  expect(snapshot(kind)).toBe(before)
})

it('快照回收失败时整笔删除回滚，包括来源、值和内存定义', () => {
  const h = open(), { source, kind, item } = make(h), before = snapshot(kind)
  h.lib.db.exec("CREATE TEMP TRIGGER fail_collect BEFORE DELETE ON main.kind_def BEGIN SELECT RAISE(ABORT, '模拟回收失败'); END")
  expect(() => h.api.run(plugin.id, 'drop', { source, item })).toThrow('模拟回收失败')
  expect(snapshot(kind)).toBe(before)
  expect(h.reg.kind(kind)).toBeDefined()
  expect(h.store.exists(source)).toBe(true)
  expect(h.store.blocksOf(item)[kind].data.value).toBe('保留字段')
})

it('重复创建删除不累积快照，同事务内临时管理记录也不留快照或历史', () => {
  const h = open()
  for (let i = 0; i < 10; i++) {
    const source = h.api.run(plugin.id, 'transient', {}) as string
    expect(snapshot(`dynamic-test:${source}`)).toBeUndefined()
    expect(h.store.exists(source)).toBe(false)
  }
  expect(h.api.undo()).toBeNull()
  expect(snapshot('dynamic-test-schema')).toBeDefined()
})

it.each([true, false])('开库回收历史残留（定义器启用：%s），静态定义与契约保持，旧会话历史清理', enabled => {
  let h = open()
  const { source, kind, item } = make(h), before = snapshot(kind)
  h.api.run(plugin.id, 'drop', { source, item })
  // 模拟旧版只删除数据、不删除动态快照的数据库。
  h.lib.db.prepare('INSERT INTO main.kind_def VALUES (?, ?)').run(kind, before)
  h.lib.db.prepare('INSERT INTO main.config VALUES (?, ?)').run('externalDefinitions:dynamic-test', JSON.stringify({ kind: 'dynamic-test-schema', prefix: 'dynamic-test:' }))
  const config = h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
  h = open(enabled)
  expect(snapshot(kind)).toBeUndefined()
  expect(h.reg.kind(kind)).toBeUndefined()
  expect(snapshot('dynamic-test-schema')).toBeDefined()
  expect(h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(config)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
})

it('停用或卸载后空来源仍保留；来源和使用者在回收站也保留', () => {
  let h = open()
  const { source, kind, item } = make(h)
  h.store.setDeletedAt(source, 123) // 旧数据可能有处于回收站的管理记录。
  h.api.trash([item])
  h = open(false)
  expect(snapshot(kind)).toBeDefined()
  expect(h.reg.kind(kind)?.dormant).toBe(true)
  h.store.purge([item])
  expect(snapshot(kind)).toBeDefined() // 没有使用者，来源仍存在。
  h.store.purge([source])
  expect(snapshot(kind)).toBeUndefined()
})

it('来源已缺失但回收站仍有字段时保留；最后使用者彻底删除才回收并通知界面', async () => {
  let h = open()
  const { source, kind, item } = make(h)
  h.store.purge([source]) // 模拟来源丢失而值尚存的异常记录。
  h.api.trash([item])
  h = open(false)
  expect(snapshot(kind)).toBeDefined()
  expect(h.reg.kind(kind)?.dormant).toBe(true)
  events.length = 0
  await h.api.purge([item])
  expect(snapshot(kind)).toBeUndefined()
  expect(h.reg.kind(kind)).toBeUndefined()
  expect(events).toContain('kinds')
  expect((await h.api.describeLibrary()).kinds.some(k => k.id === kind)).toBe(false)
})

it('来源块残留但身份缺失时保守保留快照', () => {
  let h = open()
  const { source, kind, item } = make(h)
  h.store.remove(item, kind)
  h.lib.db.prepare('DELETE FROM main.entity WHERE id = ?').run(source)
  h = open(false)
  expect(snapshot(kind)).toBeDefined()
})

it('即使异常数据落在派生库，仍按实际使用保留定义', () => {
  let h = open()
  const { source, kind, item } = make(h)
  h.lib.db.prepare('INSERT INTO derived.block SELECT * FROM main.block WHERE entity_id = ? AND kind = ?').run(item, kind)
  h.store.remove(item, kind)
  h.store.purge([source])
  h = open(false)
  expect(snapshot(kind)).toBeDefined()
  h.store.purge([item])
  expect(snapshot(kind)).toBeUndefined()
})
