import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Host } from '../../src/core/host'
import { filePlugin } from '../../src/plugins/file/core'
import type { CorePlugin } from '../../src/core/plugin'

// 只装配核心契约所需的块；不依赖标签、摘录、模板或图片插件的实现。
const probe: CorePlugin = { id: 'probe', version: 1, blocks: [
  { id: 'note', plugin: 'probe', title: '内容', version: 1, rebuildable: false, fields: { text: { type: 'text', title: '内容', search: true } } },
  { id: 'anchor', plugin: 'probe', title: '依附', version: 1, rebuildable: false, fields: { target: { type: 'ref', title: '原素材', ref: 'attach' } } },
  { id: 'link', plugin: 'probe', title: '关联', version: 1, rebuildable: false, fields: { target: { type: 'ref', title: '目标', ref: 'link' } } },
  { id: 'preview', plugin: 'probe', title: '预览', version: 1, rebuildable: true, fields: { paths: { type: 'text', title: '缓存', file: true, list: true } } },
  { id: 'processed', plugin: 'probe', title: '加工', version: 1, rebuildable: true, fields: { text: { type: 'text', title: '内容' } } },
  { id: 'manager', plugin: 'probe', title: '管理记录', version: 1, rebuildable: false, standalone: true, management: {}, fields: { title: { type: 'text', title: '名称' } } }
], systems: [{ id: 'probe.process', priority: 1, has: ['file'], inputs: ['file.hash'], outputs: ['processed'], async run() { return { processed: { text: 'processed' } } } }] }
const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(fn => fn()) })
function library() {
  const root = mkdtempSync(join(tmpdir(), 'rm-purge-'))
  const host = new Host(root, [filePlugin, probe], () => {}, { manifest: [] })
  cleanups.push(() => { host.close(); rmSync(root, { recursive: true, force: true }) })
  return host
}
function cache(host: Host, id: string, paths: string[]) {
  for (const path of paths) host.lib.files.write(path, 'preview')
  host.store.put(id, 'preview', { paths })
}
const create = (host: Host, text: string) => host.api.create({ note: { text } }) as string

it('预览去重依附素材；彻底删除记录、索引与历史，保留原件和外部 link，再导入是新身份', async () => {
  const host = library()
  const input = { type: 'bytes' as const, name: 'source.txt', bytes: Buffer.from('original') }
  const [id] = await host.api.ingest([input]); await host.scheduler.idle()
  expect(host.store.blocksOf(id).processed.data.text).toBe('processed')
  expect(host.lib.db.prepare('SELECT count(*) FROM derived.derivation WHERE entity_id=?').pluck().get(id)).toBe(1)
  const original = String(host.store.blocksOf(id).file.data.path)
  const child = host.api.create({ anchor: { target: id }, note: { text: 'unique-delete' } }) as string
  const other = host.api.create({ link: { target: id }, note: { text: 'keep' } }) as string
  cache(host, id, ['cache/a.txt']); cache(host, child, ['cache/b.txt'])
  host.api.trash([id])
  expect(host.api.purgePreview([id, child, other])).toEqual({ items: 1, locals: 1, retainedFiles: 1, skipped: [{ id: other, reason: '不在回收站里' }] })
  expect(host.api.purge([id, child])).toEqual({ ids: [id, child], purged: 1, locals: 1, failed: [] })
  expect(existsSync(host.lib.files.readable(original))).toBe(true)
  for (const path of ['cache/a.txt', 'cache/b.txt']) expect(existsSync(join(host.lib.root, path))).toBe(false)
  for (const removed of [id, child]) {
    expect(host.api.get([removed])).toEqual([])
    for (const table of ['main.block', 'main.field_index', 'main.ref', 'main.block_history', 'main.op_entity', 'derived.block', 'derived.derivation', 'derived.card_summary', 'derived.search_doc'])
      expect(host.lib.db.prepare(`SELECT count(*) FROM ${table} WHERE entity_id=?`).pluck().get(removed), table).toBe(0)
  }
  expect((await host.api.query({ text: 'unique-delete' })).ids).toEqual([])
  expect(host.store.blocksOf(other).link.data.target).toBe(id)
  const [again] = await host.api.ingest([input])
  expect(again).not.toBe(id); expect(host.store.isTrashed(again)).toBe(false)
})

it('只清除被删素材的撤销记录；同批其他素材仍可撤销恢复', () => {
  const host = library(), a = create(host, 'A'), b = create(host, 'B')
  host.api.put(b, 'note', { text: 'changed' })
  host.api.trash([a, b]); host.api.put(a, 'note', { text: 'deleted' })
  host.api.purge([a]); host.api.undo()
  expect(host.store.exists(a)).toBe(false); expect(host.store.isTrashed(b)).toBe(false)
  host.api.undo(); expect(host.store.blocksOf(b).note.data.text).toBe('B')
  host.api.redo(); expect(host.store.blocksOf(b).note.data.text).toBe('changed')
})

it('管理记录不能混入仓库回收与彻底删除', () => {
  const host = library(), ordinary = create(host, 'keep')
  const manager = host.api.create({ manager: { title: '配置' } }) as string
  for (const action of [() => host.api.trash([manager]), () => host.api.purgePreview([manager]), () => host.api.purge([ordinary, manager])]) expect(action).toThrow('管理记录')
  expect(host.store.exists(ordinary)).toBe(true); expect(host.store.exists(manager)).toBe(true)
})

it('共用缓存按剩余原始及派生记录保护，含回收站、未知块和嵌套值；无人引用后只删一次', () => {
  const host = library(), a = create(host, 'A'), b = create(host, 'B'), c = create(host, 'C')
  cache(host, a, ['cache/shared.txt', 'cache/unknown.txt', 'cache/free.txt'])
  cache(host, c, ['cache/free.txt'])
  cache(host, b, ['cache/shared.txt'])
  host.api.trash([b])
  // 模拟没有加载定义的原始块，清理不得因不认识字段而忽略它。
  host.lib.db.prepare("INSERT INTO main.block(entity_id,kind,data,schema_ver,seq,updated_at) VALUES (?,?,?,?,?,?)")
    .run(b, 'unknown', JSON.stringify({ nested: { paths: ['cache\\unknown.txt'] } }), 1, 1000, Date.now())
  host.api.trash([a, c])
  const remove = vi.spyOn(host.lib.files, 'removeCache')
  host.api.purge([a, c])
  expect(existsSync(join(host.lib.root, 'cache/shared.txt'))).toBe(true)
  expect(existsSync(join(host.lib.root, 'cache/unknown.txt'))).toBe(true)
  expect(remove.mock.calls).toEqual([['cache/free.txt']])
  host.api.purge([b])
  expect(existsSync(join(host.lib.root, 'cache/shared.txt'))).toBe(false)
  // 未知定义的文件不作为删除候选，保守保留。
  expect(existsSync(join(host.lib.root, 'cache/unknown.txt'))).toBe(true)
})


it('引用扫描失败保留候选缓存，记录删除仍完成；数据库删除失败则记录与缓存都保留', () => {
  const host = library(), a = create(host, 'A'), b = create(host, 'B')
  cache(host, a, ['cache/a.txt']); cache(host, b, ['cache/b.txt'])
  host.api.trash([a, b])
  host.lib.db.exec("CREATE TRIGGER deny_purge BEFORE DELETE ON entity BEGIN SELECT RAISE(ABORT,'injected'); END")
  expect(() => host.api.purge([a])).toThrow('injected')
  expect(host.store.exists(a)).toBe(true); expect(existsSync(join(host.lib.root, 'cache/a.txt'))).toBe(true)
  host.lib.db.exec('DROP TRIGGER deny_purge')
  const prepare = host.lib.db.prepare.bind(host.lib.db)
  const spy = vi.spyOn(host.lib.db, 'prepare').mockImplementation((sql: string) => {
    if (sql.includes('SELECT data FROM main.block UNION ALL')) throw new Error('injected scan failure')
    return prepare(sql)
  })
  expect(host.api.purge([a, b])).toMatchObject({ purged: 2 })
  expect(host.store.exists(a)).toBe(false); expect(host.store.exists(b)).toBe(false)
  expect(existsSync(join(host.lib.root, 'cache/a.txt'))).toBe(true)
  expect(existsSync(join(host.lib.root, 'cache/b.txt'))).toBe(true)
  spy.mockRestore()
})

it('生命周期回执失败回滚记录并保留缓存；成功提交后清理，重放不再删除', async () => {
  const host = library(), id = create(host, 'retain')
  cache(host, id, ['cache/receipt.txt']); host.api.trash([id])
  const preview = await host.api.previewItemLifecycle({ action: 'purge', ids: [id] })
  const input = { action: 'purge' as const, ids: [id], previewToken: preview.previewToken, requestId: 'purge-receipt-failure' }
  const remove = vi.spyOn(host.lib.files, 'removeCache')
  host.lib.db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON operation_receipt BEGIN SELECT RAISE(ABORT,'receipt failure'); END")
  expect(() => host.api.applyItemLifecycle(input)).toThrow('receipt failure')
  expect(host.store.exists(id)).toBe(true)
  expect(existsSync(join(host.lib.root, 'cache/receipt.txt'))).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  host.lib.db.exec('DROP TRIGGER deny_receipt')
  expect(await host.api.applyItemLifecycle(input)).toMatchObject({ replayed: false })
  expect(existsSync(join(host.lib.root, 'cache/receipt.txt'))).toBe(false)
  expect(await host.api.applyItemLifecycle(input)).toMatchObject({ replayed: true })
  expect(remove).toHaveBeenCalledTimes(1)
})

it('嵌套回滚丢弃本层缓存清理；外层提交前新引用仍保护缓存', () => {
  const host = library(), a = create(host, 'A'), b = create(host, 'B'), c = create(host, 'C')
  cache(host, a, ['cache/a.txt']); cache(host, b, ['cache/b.txt']); host.api.trash([a, b])
  host.store.batch(() => {
    expect(() => host.store.batch(() => { host.api.purge([a]); throw new Error('rollback inner') })).toThrow('rollback inner')
    host.api.purge([b])
    expect(existsSync(join(host.lib.root, 'cache/b.txt'))).toBe(true)
    host.store.put(c, 'preview', { paths: ['cache/b.txt'] })
  })
  expect(host.store.exists(a)).toBe(true); expect(host.store.exists(b)).toBe(false)
  for (const path of ['cache/a.txt', 'cache/b.txt']) expect(existsSync(join(host.lib.root, path))).toBe(true)
})
