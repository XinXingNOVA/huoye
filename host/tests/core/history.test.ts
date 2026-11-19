// 撤销与重做，以及模板的结构演变（设计文档 11.6）。

import { afterEach, describe, expect, it } from 'vitest'
import { templateKindId, type FieldSpec } from '../fixtures/legacy-fields/blocks'
import { convertValue } from '../fixtures/legacy-fields/lib/convert'
import { openHost } from '../helpers/helpers'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup(root?: string) {
  const h = openHost(undefined, undefined, root)
  cleanups.push(h.cleanup)
  return h
}

const tag = (value: string) => ({ op: 'eq' as const, kind: 'tags', field: 'values', value })
const ids = (r: unknown) => (r as { ids: string[] }).ids

describe('撤销与重做', () => {
  it('改字段：撤销回到原来的值，重做再改回来', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.patch(a, 'status', { value: '待处理' })
    host.api.patch(a, 'status', { value: '进行中' })
    expect(host.api.undo()).toBe('修改状态')
    expect(host.store.blocksOf(a).status.data.value).toBe('待处理')
    expect(host.api.undo()).toBe('修改状态')
    expect(host.store.blocksOf(a).status).toBeUndefined()
    expect(host.api.redo()).toBe('修改状态')
    expect(host.store.blocksOf(a).status.data.value).toBe('待处理')
  })

  it('放入视图是一个操作：几项一起撤销', async () => {
    const { host } = setup()
    const [a, b] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' }
    ])
    host.api.put(a, 'tags', { values: ['光影'] })
    await host.api.admit([a, b], { where: [tag('配色')] })
    expect(host.api.undo()).toBe('放入：标签为「配色」（2 项）')
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['光影'])
    expect(host.store.blocksOf(b).tags).toBeUndefined()
  })

  it('移到回收站、收录也能撤销；收录撤销后进回收站', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.trash([a])
    expect(host.api.undo()).toBe('移到回收站（1 项）')
    expect(host.store.isTrashed(a)).toBe(false)
    expect(host.api.redo()).toBe('移到回收站（1 项）')
    expect(host.store.isTrashed(a)).toBe(true)
    host.api.undo()
    expect(host.api.undo()).toBe('收录 1 项')
    expect(host.store.isTrashed(a)).toBe(true)
    expect(host.api.undo()).toBeNull()
  })

  it('撤销后又做了新操作，就不能再重做', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.patch(a, 'status', { value: '待处理' })
    host.api.undo()
    host.api.patch(a, 'status', { value: '搁置' })
    expect(host.api.redo()).toBeNull()
  })

  it('没写任何东西的操作不留下；只撤销这次运行里的操作', async () => {
    const first = setup()
    const [a] = await first.host.api.ingest([{ type: 'text', text: '一' }])
    first.host.api.patch(a, 'status', { value: '待处理' })
    first.host.api.patch(a, 'status', { value: '待处理' })
    expect(first.host.api.undo()).toBe('修改状态')
    expect(first.host.api.undo()).toBe('收录 1 项')
    first.host.api.redo()
    first.host.api.redo()
    first.host.close()
    cleanups = []
    const second = setup(first.root)
    expect(second.host.api.undo()).toBeNull()
    expect(second.host.store.blocksOf(a).status.data.value).toBe('待处理')
  })

  it('新建模板可以撤销：不留回收站空条目，定义不再注册；重做回来', () => {
    const { host, events } = setup()
    const id = host.api.create({ template: { title: '影视片段', fields: [] } }) as string
    const kind = templateKindId(id)
    expect(host.reg.kind(kind)).toBeDefined()
    events.length = 0
    expect(host.api.undo()).toBe('新建模板「影视片段」')
    expect(host.reg.kind(kind)).toBeUndefined()
    expect(host.store.exists(id)).toBe(false)
    expect(events.some((e) => e.event === 'kinds')).toBe(true)
    host.api.redo()
    expect(host.reg.kind(kind)?.title).toBe('影视片段')
    expect(host.store.isTrashed(id)).toBe(false)
  })
})

const FILM: FieldSpec[] = [
  { id: 'fshot', title: '镜头', type: 'select', options: ['推', '拉', '跟'] },
  { id: 'fname', title: '片名', type: 'text' },
  { id: 'fyear', title: '年份', type: 'text' }
]

async function filmLibrary() {
  const { host } = setup()
  const template = host.api.create({ template: { title: '影视片段', fields: FILM } }) as string
  const kind = templateKindId(template)
  const [a, b, c] = await host.api.ingest([
    { type: 'text', text: '一' },
    { type: 'text', text: '二' },
    { type: 'text', text: '三' }
  ])
  host.api.put(a, kind, { fshot: '推', fname: '花样年华', fyear: '2000' })
  host.api.put(b, kind, { fshot: '跟', fname: '一代宗师', fyear: '二〇一三' })
  host.api.put(c, kind, { fshot: '推' })
  return { host, template, kind, a, b, c }
}

describe('模板的结构演变', () => {
  it('单选改成多选：值变成一项的列表；撤销时先恢复定义再恢复数据', async () => {
    const { host, template, kind, a } = await filmLibrary()
    const r = host.api.run('fields', 'changeType', { template, field: 'fshot', type: 'multi' }) as { total: number; cleared: number }
    expect(r).toMatchObject({ total: 3, cleared: 0 })
    expect(host.reg.kind(kind)!.fields.fshot).toMatchObject({ type: 'enum', list: true })
    expect(host.store.blocksOf(a)[kind].data.fshot).toEqual(['推'])
    expect(ids(host.api.query({ where: [{ op: 'eq', kind, field: 'fshot', value: '推' }] }))).toHaveLength(2)

    expect(host.api.undo()).toBe('把「镜头」从单选改成多选')
    expect(host.reg.kind(kind)!.fields.fshot.list).toBeFalsy()
    expect(host.store.blocksOf(a)[kind].data.fshot).toBe('推')
    // 索引按恢复后的定义重建
    expect(ids(host.api.query({ where: [{ op: 'eq', kind, field: 'fshot', value: '推' }] }))).toHaveLength(2)
  })

  it('文本改成数字：能转的转，转不了的清空；预演不留下任何东西', async () => {
    const { host, template, kind, a, b } = await filmLibrary()
    const before = host.store.blocksOf(b)[kind].data
    const preview = host.api.preview('fields', 'changeType', { template, field: 'fyear', type: 'number' })
    expect(preview).toMatchObject({ total: 2, cleared: 1 })
    expect(host.reg.kind(kind)!.fields.fyear.type).toBe('text')
    expect(host.store.blocksOf(b)[kind].data).toEqual(before)
    // 预演没有留下操作：最近的一个仍然是填片名的那次
    expect(host.api.undo()).toBe('修改影视片段')
    host.api.redo()
    host.api.run('fields', 'changeType', { template, field: 'fyear', type: 'number' })
    expect(host.store.blocksOf(a)[kind].data.fyear).toBe(2000)
    expect(host.store.blocksOf(b)[kind].data.fyear).toBeUndefined()
    host.api.undo()
    expect(host.store.blocksOf(b)[kind].data.fyear).toBe('二〇一三')
  })

  it('文本改成单选：出现过的值成为选项', async () => {
    const { host, template, kind } = await filmLibrary()
    const r = host.api.run('fields', 'changeType', { template, field: 'fname', type: 'select' }) as { options: string[] }
    expect(r.options).toEqual(['花样年华', '一代宗师'])
    expect(host.reg.kind(kind)!.fields.fname.options).toEqual(['花样年华', '一代宗师'])
  })

  it('选项改名、合并、删除', async () => {
    const { host, template, kind, a, b, c } = await filmLibrary()
    host.api.run('fields', 'renameOption', { template, field: 'fshot', from: '跟', to: '跟拍' })
    expect(host.reg.kind(kind)!.fields.fshot.options).toEqual(['推', '拉', '跟拍'])
    expect(host.store.blocksOf(b)[kind].data.fshot).toBe('跟拍')

    expect(host.api.run('fields', 'renameOption', { template, field: 'fshot', from: '跟拍', to: '推' })).toEqual({ total: 3 })
    expect(host.reg.kind(kind)!.fields.fshot.options).toEqual(['推', '拉'])
    expect(host.store.blocksOf(b)[kind].data.fshot).toBe('推')

    expect(host.api.run('fields', 'deleteOption', { template, field: 'fshot', option: '推' })).toEqual({ cleared: 3 })
    for (const id of [a, b, c]) expect(host.store.blocksOf(id)[kind].data.fshot).toBeUndefined()
    // 模板块空了也留着：它表示"属于这张表"
    expect(host.store.blocksOf(c)[kind].data).toEqual({})

    host.api.undo()
    host.api.undo()
    expect(host.store.blocksOf(b)[kind].data.fshot).toBe('跟拍')
  })

  it('删除字段：值清空，撤销后回来', async () => {
    const { host, template, kind, a } = await filmLibrary()
    expect(host.api.preview('fields', 'deleteField', { template, field: 'fname' })).toEqual({ cleared: 2 })
    host.api.run('fields', 'deleteField', { template, field: 'fname' })
    expect(host.reg.kind(kind)!.fields.fname).toBeUndefined()
    expect(host.store.blocksOf(a)[kind].data).toEqual({ fshot: '推', fyear: '2000' })
    expect(host.api.undo()).toBe('删除字段「片名」')
    expect(host.store.blocksOf(a)[kind].data.fname).toBe('花样年华')
  })

  it('标签升级为模板：带标签的素材挂上同名模板，标签去掉；一次撤销全部回去', async () => {
    const { host } = setup()
    const [a, b, c] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
      { type: 'text', text: '三' }
    ])
    host.api.put(a, 'tags', { values: ['运镜', '光影'] })
    host.api.put(b, 'tags', { values: ['运镜'] })
    host.api.put(c, 'tags', { values: ['光影'] })
    const r = host.api.run('fields', 'promoteTag', { tag: '运镜' }) as { kind: string; count: number }
    expect(r.count).toBe(2)
    expect(host.reg.kind(r.kind)?.title).toBe('运镜')
    expect(ids(host.api.query({ has: [r.kind] })).sort()).toEqual([a, b].sort())
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['光影'])
    expect(host.store.blocksOf(b).tags).toBeUndefined()

    expect(host.api.undo()).toBe('把标签「运镜」升级为模板')
    expect(host.reg.kind(r.kind)).toBeUndefined()
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['运镜', '光影'])
    expect(host.store.blocksOf(b).tags.data.values).toEqual(['运镜'])
    expect(host.store.blocksOf(a)[r.kind]).toBeUndefined()
  })
})

describe('值的类型转换', () => {
  const spec = (type: FieldSpec['type'], options?: string[]): FieldSpec => ({ id: 'fx', title: 'x', type, options })
  it('常见的转换', () => {
    expect(convertValue(['推', '拉'], spec('multi'), spec('text'))).toBe('推、拉')
    expect(convertValue('3', spec('text'), spec('rating'))).toBe(3)
    expect(convertValue('9', spec('text'), spec('rating'))).toBeUndefined()
    expect(convertValue('是', spec('text'), spec('checkbox'))).toBe(true)
    expect(convertValue(true, spec('checkbox'), spec('text'))).toBe('是')
    expect(convertValue('2024-03-05', spec('text'), spec('date'))).toBe(new Date(2024, 2, 5).getTime())
    expect(convertValue('拉', spec('select', ['推', '拉']), spec('multi', ['推', '拉']))).toEqual(['拉'])
    expect(convertValue(['推', '拉'], spec('multi', ['推', '拉']), spec('select', ['推', '拉']))).toBe('推')
  })
})

describe('定义不在了的数据块', () => {
  it('查询里的模板被撤销掉：什么也匹配不到，不出错', () => {
    const { host } = setup()
    const id = host.api.create({ template: { title: '光影', fields: [{ id: 'fab', title: 'a', type: 'text' }] } }) as string
    const kind = templateKindId(id)
    host.api.undo()
    expect(ids(host.api.query({ has: [kind] }))).toEqual([])
    expect(ids(host.api.query({ where: [{ op: 'eq', kind, field: 'fab', value: 'x' }] }))).toEqual([])
    expect(() => host.api.query({ sort: { kind, field: 'fab' } })).not.toThrow()
  })
})

describe('业务历史增量升级', () => {
  it('打开时补齐历史列并清理旧会话，之后的操作能撤销', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { join } = await import('node:path')
    const { tempDir } = await import('../helpers/helpers')
    const root = tempDir('rm-old-')
    const initial = openHost(undefined, undefined, root); initial.host.close()
    const db = new Database(join(root, 'library.db'))
    db.exec(`DROP TABLE block_history; CREATE TABLE block_history (entity_id TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT, at INTEGER NOT NULL);
             INSERT INTO block_history VALUES ('x', 'tags', 1, NULL, 0);`)
    db.close()
    const { host } = setup(root)
    expect(host.lib.db.prepare('SELECT COUNT(*) FROM main.block_history').pluck().get()).toBe(0)
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.patch(a, 'status', { value: '进行中' })
    expect(host.api.undo()).toBe('修改状态')
    expect(host.store.blocksOf(a).status).toBeUndefined()
  })
})


describe('公开会话历史', () => {
  it('分页摘要、影响范围与顺序撤销共用真实历史；过期按钮不能撤销后来操作', async () => {
    const { host, events } = setup()
    const a = await host.api.create({ text: { content: '不应出现在历史摘要中的正文' } })
    const b = await host.api.create({ text: { content: 'B' } })
    host.api.run('tags', 'update', { ids: [a, b], add: ['批量'] })
    const page = await host.api.listHistory({ limit: 1 })
    expect(page.entries[0]).toMatchObject({ affected: 2, kinds: ['tags'], source: 'application', plugin: 'tags', operation: 'update' })
    expect(page.total).toBe(3)
    expect(JSON.stringify(page)).not.toContain('不应出现在')
    const second = await host.api.listHistory({ before: page.nextBefore!, limit: 1 })
    expect(second.entries[0].id).toBeLessThan(page.entries[0].id)
    const detail = await host.api.readHistory({ id: page.entries[0].id, limit: 1 })
    const next = await host.api.readHistory({ id: page.entries[0].id, offset: detail.nextOffset!, limit: 1 })
    expect([...detail.entities, ...next.entities].map(e => e.id).sort()).toEqual([a, b].sort())
    expect(next.nextOffset).toBeNull()
    const expected = { session: page.session, revision: page.revision, id: page.undo!.id }
    host.api.patch(a, 'text', { content: '后来修改' })
    expect(() => host.api.undo(expected)).toThrow('HISTORY_CHANGED')
    expect(host.store.blocksOf(a).text.data.content).toBe('后来修改')
    const current = await host.api.listHistory()
    host.api.undo({ session: current.session, revision: current.revision, id: current.undo!.id })
    expect((await host.api.listHistory()).entries[0].state).toBe('undone')
    host.api.put(a, 'note', { text: '新分支' })
    expect((await host.api.listHistory()).redo).toBeNull()
    expect((await host.api.listHistory()).entries.find(e => e.id === current.undo!.id)).toBeUndefined()
    const total = (await host.api.listHistory()).total, notifications = events.filter(e => e.event === 'historyChanged').length
    host.api.put(a, 'note', { text: '新分支' })
    host.api.preview('tags', 'update', { ids: [a], add: ['预演'] })
    expect((await host.api.listHistory()).total).toBe(total)
    expect(events.filter(e => e.event === 'historyChanged')).toHaveLength(notifications)
    host.api.trash([b]); host.api.purge([b])
    expect((await host.api.readHistory({ id: page.entries[0].id })).entry.affected).toBe(1)
    expect(() => host.api.listHistory({ limit: 101 })).toThrow()
  })

  it('旧表升级保留数据与回执；重开不公开或撤销上次会话', async () => {
    const first = setup(), request = { operation: 'create_text', requestId: 'history-upgrade', args: { content: '保留内容' } }
    const receipt = await first.host.api.executeOperation(request)
    const previous = await first.host.api.listHistory()
    first.host.lib.db.exec('ALTER TABLE main.operation DROP COLUMN context')
    first.host.close()
    const { host } = setup(first.root)
    expect(await host.api.listHistory()).toMatchObject({ entries: [], total: 0, undo: null, redo: null })
    expect(() => host.api.readHistory({ id: previous.entries[0].id })).toThrow('HISTORY_UNAVAILABLE')
    expect(await host.api.executeOperation(request)).toEqual({ ...receipt, replayed: true })
    expect((await host.api.listHistory()).entries).toEqual([])
    const id = await host.api.create({ text: { content: '新的会话' } })
    expect(() => host.api.undo({ session: previous.session, revision: previous.revision, id: previous.undo!.id })).toThrow('HISTORY_CHANGED')
    expect(host.store.exists(id)).toBe(true)
  })
})

describe('历史保留预算', () => {
  it('保留最近 1000 个完整操作；回滚不裁剪，重放不产生快照，新分支彻底清理重做', async () => {
    const { host, events } = setup()
    const a = host.store.createEntity(), b = host.store.createEntity()
    host.store.batch(() => {
      for (let i = 0; i < 1000; i++) host.api.put(a, 'note', { text: String(i) })
    })
    const before = await host.api.listHistory()
    events.length = 0
    expect(() => host.store.batch(() => {
      host.api.put(a, 'note', { text: '应回滚' })
      throw new Error('回执写入失败')
    })).toThrow('回执写入失败')
    expect(await host.api.listHistory()).toEqual(before)
    expect(events.some(e => e.event === 'historyChanged')).toBe(false)
    host.history.run('批量', () => {
      host.store.put(a, 'note', { text: '甲' }); host.store.put(b, 'note', { text: '乙' })
    })
    const retained = await host.api.listHistory()
    expect(retained).toMatchObject({ total: 1000, retention: { limit: 1000, trimmed: 1 } })
    expect(retained.entries[0].affected).toBe(2)
    const snapshots = host.lib.db.prepare('SELECT * FROM block_history ORDER BY seq').all()
    host.api.undo()
    expect(host.store.blocksOf(a).note.data.text).toBe('999')
    expect(host.store.blocksOf(b).note).toBeUndefined()
    host.api.redo()
    expect(host.store.blocksOf(b).note.data.text).toBe('乙')
    expect(host.lib.db.prepare('SELECT * FROM block_history ORDER BY seq').all()).toEqual(snapshots)
    host.api.undo()
    host.api.put(a, 'note', { text: '999' }) // 空操作不能丢弃重做。
    expect((await host.api.listHistory()).redo).not.toBeNull()
    host.api.put(a, 'note', { text: '新分支' })
    for (const table of ['block_history', 'op_entity', 'record_history'])
      expect(host.lib.db.prepare(`SELECT count(*) FROM ${table} WHERE op=?`).pluck().get(retained.undo!.id)).toBe(0)
    expect(() => host.api.readHistory({ id: retained.undo!.id })).toThrow('HISTORY_UNAVAILABLE')
    // 剩余链是连续后缀：不能越过已裁剪的第一笔，但后续步骤仍逐项可撤销／重做。
    host.store.batch(() => { for (let i = 0; i < 1000; i++) host.api.undo() })
    expect(host.api.undo()).toBeNull()
    expect(host.store.blocksOf(a).note.data.text).toBe('0')
    expect((await host.api.listHistory()).total).toBe(1000)
    host.api.redo()
    expect(host.store.blocksOf(a).note.data.text).toBe('1')
  })

  it('64 MiB 按 UTF-8 载荷裁剪，最新超大批量仍能整体撤销重做', async () => {
    const h = openHost([{ id: 'payload', version: 1, blocks: [{ id: 'payload', plugin: 'payload', title: '载荷', version: 1, rebuildable: false,
      fields: { value: { type: 'longtext', title: '内容' } } }] }], { manifest: [] })
    cleanups.push(h.cleanup)
    const { host } = h, a = host.store.createEntity(), b = host.store.createEntity()
    const value = '数'.repeat(6 * 1024 * 1024) // 每项约 18 MiB；两项替换的前后快照超过预算。
    host.history.run('第一批', () => {
      host.store.put(a, 'payload', { value }); host.store.put(b, 'payload', { value })
    })
    host.history.run('大批量', () => {
      host.store.put(a, 'payload', { value: value + '甲' }); host.store.put(b, 'payload', { value: value + '乙' })
    })
    const page = await host.api.listHistory()
    expect(page).toMatchObject({ total: 1, retention: { trimmed: 1, byteLimit: 64 * 1024 * 1024 } })
    expect(page.retention!.bytes).toBeGreaterThan(page.retention!.byteLimit)
    host.api.undo()
    expect(host.store.blocksOf(a).payload.data.value).toBe(value)
    expect(host.store.blocksOf(b).payload.data.value).toBe(value)
    host.api.redo()
    expect(host.store.blocksOf(b).payload.data.value).toBe(value + '乙')
    expect((await host.api.listHistory()).retention!.bytes).toBe(page.retention!.bytes)
    // 下一次小写入释放超大历史；当前两个数据块仍完整存在。
    host.api.create({})
    expect((await host.api.listHistory()).total).toBe(1)
    expect(host.store.blocksOf(a).payload.data.value).toBe(value + '甲')
  })
})
