import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Host } from '../../src/core/host'
import type { CorePlugin } from '../../src/core/plugin'

const probe: CorePlugin = {
  id: 'probe', version: 1,
  blocks: [
    { id: 'work', plugin: 'probe', version: 1, title: '作品', content: true, rebuildable: false, fields: {} },
    { id: 'anchor', plugin: 'probe', version: 1, title: '依附内容', rebuildable: false,
      fields: { parent: { type: 'ref', ref: 'attach', title: '依附目标' } } },
    { id: 'part', plugin: 'probe', version: 1, title: '从属项', standalone: true, ownedBy: 'owner', rebuildable: false,
      fields: { owner: { type: 'ref', ref: 'attach', index: true, title: '所属作品' }, source: { type: 'ref', ref: 'link', title: '来源' } } }
  ],
  commands: {
    add(ctx, { owner, source, count }) {
      const ids = Array.from({ length: Number(count) }, () => {
        const id = ctx.createEntity()
        ctx.put(id, 'part', { owner, source })
        return id
      })
      return { label: '增加从属项', result: ids }
    },
    move(ctx, { id, owner }) {
      ctx.put(String(id), 'part', { ...ctx.blocksOf(String(id)).part.data, owner })
      return { label: '转移从属项' }
    },
    conditional(ctx, { first, source, expected }) {
      const id = String(first)
      ctx.put(id, 'part', { ...ctx.blocksOf(id).part.data, source })
      ctx.expectBlocks(expected as { id: string; kind: string; seq: number }[])
      return { label: '条件更新' }
    },
    drop(ctx, { id }) { ctx.deleteRecord(String(id)); return { label: '移除从属项' } }
  }
}

let root: string, host: Host
function open(plugins = [probe]) { return host = new Host(root, plugins, () => {}, { manifest: [] }) }
function setup(count: number) {
  root = mkdtempSync(join(tmpdir(), 'huoye-owned-'))
  open()
  const owner = host.api.create({ work: {} }) as string, source = host.api.create({ work: {} }) as string
  const ids = host.api.run('probe', 'add', { owner, source, count }) as string[]
  return { owner, source, ids }
}
afterEach(() => { host.close(); rmSync(root, { recursive: true, force: true }) })

it('只向作品级联：一百二十项随行，停用插件后仍能恢复与处置', async () => {
  const { owner, source, ids } = setup(120)
  expect((await host.api.query({})).ids.sort()).toEqual([owner, source].sort())
  expect((await host.api.query({ scope: 'all', has: ['part'] })).ids).toHaveLength(120)
  expect(() => host.api.trash([ids[0]])).toThrow('从属记录')
  expect(() => host.api.put(ids[0], 'work', {})).toThrow('从属记录')
  expect(() => host.api.remove(owner, 'work')).toThrow('从属记录')
  expect(() => host.api.run('probe', 'add', { owner: 'missing', source, count: 1 })).toThrow('活跃的内容')
  expect(await host.api.previewItemLifecycle({ action: 'trash', ids: [owner] })).toMatchObject({ selected: 1, affected: 121, ownedRecords: 120 })
  host.api.trash([owner])
  expect((await host.api.query({ scope: 'trash' })).ids).toEqual([owner])
  await host.scheduler.idle()
  host.close()
  open([])
  expect(host.reg.kind('part')).toMatchObject({ ownedBy: 'owner', dormant: true })
  expect((await host.api.query({ scope: 'trash' })).ids).toEqual([owner])
  host.api.restore([owner])
  expect(new Set((await host.api.query({ scope: 'all', has: ['part'] })).ids)).toEqual(new Set(ids))
  host.api.trash([owner])
  expect(await host.api.purgePreview([owner])).toMatchObject({ items: 1, locals: 120, ownedRecords: 120 })
  expect(await host.api.purge([owner])).toMatchObject({ purged: 1, locals: 120, ownedRecords: 120 })
  expect(host.store.get([source, owner, ...ids]).map(e => e.id)).toEqual([source])
})

it('混合从属记录和普通依附内容时，两类计数可在预览和结果中核对', async () => {
  const { owner } = setup(2)
  await host.api.create({ anchor: { parent: owner } })
  expect(await host.api.previewItemLifecycle({ action: 'trash', ids: [owner] })).toMatchObject({ selected: 1, affected: 4, ownedRecords: 2 })
  await host.api.trash([owner])
  expect(await host.api.purgePreview([owner])).toMatchObject({ items: 1, locals: 3, ownedRecords: 2 })
  expect(await host.api.purge([owner])).toMatchObject({ purged: 1, locals: 3, ownedRecords: 2 })
})

it('从属项增删可复原身份；清空所属作品后不能经旧历史复活', async () => {
  const { owner, source, ids: [id] } = setup(1)
  host.api.undo()
  expect(host.store.exists(id)).toBe(false)
  host.api.redo()
  expect(host.store.blocksOf(id).part.data).toEqual({ owner, source })
  host.api.run('probe', 'drop', { id })
  expect(host.store.exists(id)).toBe(false)
  expect((await host.api.query({ scope: 'trash' })).ids).toEqual([])
  host.api.undo()
  expect(host.store.blocksOf(id).part.data).toEqual({ owner, source })
  host.api.redo()
  host.api.trash([owner])
  host.api.purge([owner])
  while (await host.api.undo()) expect(host.store.exists(id)).toBe(false)
  while (await host.api.redo()) expect(host.store.exists(id)).toBe(false)
  expect(host.store.exists(source)).toBe(true)
})

it('条件提交与预演核对活跃持久块，过期或已回收会回滚之前的写入', () => {
  const { owner, source, ids: [first, second] } = setup(2)
  const get = (id: string) => host.store.blocksOf(id).part
  const original = get(first)
  const expected = [{ id: second, kind: 'part', seq: get(second).seq }]
  const args = { first, source: owner, expected }
  host.api.preview('probe', 'conditional', args)
  expect(get(first)).toEqual(original)
  host.api.run('probe', 'conditional', args)
  expect(get(first).data.source).toBe(owner)
  host.api.undo()
  host.api.run('probe', 'drop', { id: second })
  host.api.undo()
  expect(get(second).seq).toBeGreaterThan(expected[0].seq)
  const baseline = get(first)
  for (const method of ['preview', 'run'] as const) {
    expect(() => host.api[method]('probe', 'conditional', args)).toThrow('[BLOCK_CHANGED]')
    expect(get(first)).toEqual(baseline)
  }
  const target = { id: source, kind: 'work', seq: host.store.blocksOf(source).work.seq }
  host.api.trash([source])
  expect(() => host.api.run('probe', 'conditional', { ...args, expected: [target] })).toThrow('[BLOCK_CHANGED]')
  expect(get(first)).toEqual(baseline)
})

it('从属项转入另一作品后，清空原作品与重放新作品历史均保持归属有效', async () => {
  const { owner, source, ids: [id] } = setup(1)
  const next = await host.api.create({ work: {} })
  await host.api.run('probe', 'move', { id, owner: next })
  await host.api.trash([owner])
  await host.api.purge([owner])
  expect(host.store.blocksOf(id).part.data).toEqual({ owner: next, source })
  await host.api.undo()
  expect(host.store.isTrashed(next)).toBe(true)
  expect(host.store.isTrashed(id)).toBe(true)
  await host.api.redo()
  expect(host.store.isTrashed(next)).toBe(false)
  expect(host.store.isTrashed(id)).toBe(false)
})
