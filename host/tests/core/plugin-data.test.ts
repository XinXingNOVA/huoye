import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../../src/core/host'
import type { CorePlugin } from '../../src/core/plugin'
import { filePlugin } from '../../src/plugins/file/core'
import { checkPackageKinds } from '../../src/core/external-plugins'
import { validateDataLifecycle } from '../../src/core/plugin-data-registration'
import type { PluginDataPreview } from '../../src/shared/plugin-data'

const probe: CorePlugin = { id: 'probe', version: 1, dataLifecycle: { version: 1, disposableRecords: ['record'] }, blocks: [
  { id: 'mark', plugin: 'probe', title: '属性', rebuildable: false, version: 1, fields: { text: { type: 'text', title: '文字', search: true, index: true } } },
  { id: 'record', plugin: 'probe', title: '记录', content: true, standalone: true, rebuildable: false, version: 1, fields: { title: { type: 'text', title: '名称', search: true } } },
  { id: 'cached', plugin: 'probe', title: '缓存', rebuildable: true, version: 1, fields: { paths: { type: 'text', title: '路径', file: true, list: true } } }
] }
const other: CorePlugin = { id: 'other', version: 1, blocks: [
  { id: 'body', plugin: 'other', title: '正文', content: true, rebuildable: false, version: 1, fields: { text: { type: 'text', title: '文字' } } },
  { id: 'note', plugin: 'other', title: '附加信息', rebuildable: false, version: 1, fields: { text: { type: 'text', title: '文字' }, parent: { type: 'ref', title: '依附', ref: 'attach' } } },
  { id: 'shared', plugin: 'other', title: '共享产物', rebuildable: true, version: 1, fields: { path: { type: 'text', title: '文件', file: true } } }
] }
const manifest = [{ id: 'file', title: '文件', description: '', required: true }, { id: 'other', title: '其他', description: '' }, { id: 'probe', title: '探针', description: '' }]
const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(f => f()) })
function setup(plugin = probe) {
  const root = mkdtempSync(join(tmpdir(), 'rm-plugin-data-'))
  let host = new Host(root, [filePlugin, other, plugin], () => {}, { manifest })
  cleanups.push(() => { host.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, get host() { return host }, reopen(companion = other) {
    host.close(); host = new Host(root, [filePlugin, companion], () => {}, { manifest: manifest.filter(p => p.id !== 'probe') })
  } }
}
const preview = (host: Host, mode: 'all' | 'derived' = 'all') => host.api.previewPluginDataCleanup({ pluginId: 'probe', mode }) as PluginDataPreview
const clean = (host: Host, p = preview(host)) => host.api.cleanupPluginData({ pluginId: p.pluginId, mode: p.mode, token: p.token })

it('停用与包缺失保留数据；显式清理摘除属性、销毁声明记录，保留混合记录、外部依附及原件', async () => {
  const f = setup(), h = f.host
  const [file] = await h.api.ingest([{ type: 'bytes', name: 'original.txt', bytes: Buffer.from('original') }]); await h.scheduler.idle()
  const path = String(h.store.blocksOf(file).file.data.path)
  h.api.put(file, 'mark', { text: 'remove me' }); h.api.trash([file])
  const record = h.api.create({ record: { title: 'exclusive' } }) as string
  const mixed = h.api.create({ record: { title: 'mixed' }, note: { text: 'keep foreign data' } }) as string
  const parent = h.api.create({ record: { title: 'parent' } }) as string
  const child = h.api.create({ note: { parent, text: 'attachment' } }) as string
  expect(preview(h).blocked.join()).toContain('停用')
  h.api.setPlugins(['probe'])
  expect(preview(h).blocked.join()).toContain('重载')
  f.reopen()
  expect(f.host.store.blocksOf(file).mark.data.text).toBe('remove me')
  const p = preview(f.host)
  expect(p.blocked).toEqual([]); expect(p.entities).toBe(1); expect(p.resetSchema).toBe(false)
  expect(p.retained.map(r => r.id)).toEqual(expect.arrayContaining([mixed, parent]))
  await clean(f.host, p)
  expect(f.host.store.exists(record)).toBe(false)
  expect(f.host.store.blocksOf(file).mark).toBeUndefined()
  expect(f.host.store.isTrashed(file)).toBe(true)
  expect(existsSync(f.host.lib.files.readable(path))).toBe(true)
  expect(f.host.store.blocksOf(mixed).note.data.text).toBe('keep foreign data')
  expect(f.host.store.blocksOf(mixed).record).toBeDefined()
  expect(f.host.store.blocksOf(child).note.data.parent).toBe(parent)
})

it('完整清理重置旧结构契约；动态定义及使用块一起清除，外部回执和启停选择保留', async () => {
  const dynamic: CorePlugin = { ...probe, blocks: [...probe.blocks!, { id: 'template', plugin: 'probe', title: '模板', standalone: true, management: {}, version: 1, rebuildable: false, fields: { title: { type: 'text', title: '名称' } } }],
    dataLifecycle: { version: 1, disposableRecords: ['record', 'template'] }, defines: { kind: 'template', prefix: 'probe:', build: (id) => ({ id: `probe:${id}`, plugin: 'probe', template: id, title: '动态', version: 1, rebuildable: false, fields: { value: { type: 'text', title: '值' } } }) } }
  const f = setup(dynamic), id = f.host.api.create({ body: { text: 'retained' } }) as string
  const template = f.host.api.create({ template: { title: 'fields' } }) as string
  f.host.api.put(id, `probe:${template}`, { value: 'remove' })
  f.host.api.setPlugins(['probe'])
  f.host.lib.db.prepare('INSERT INTO main.config VALUES (?,?)').run('externalSchema:probe', JSON.stringify(probe.blocks!.filter(k => !k.rebuildable)))
  f.host.lib.db.prepare('INSERT INTO main.config VALUES (?,?)').run('externalDefinitions:probe', JSON.stringify({ kind: 'template', prefix: 'probe:' }))
  f.host.lib.db.exec("INSERT INTO main.operation_receipt VALUES ('request','signature','{}',1)")
  f.reopen()
  const changed = [{ ...probe.blocks![0], fields: { number: { type: 'number' as const, title: '新的结构' } } }]
  expect(() => checkPackageKinds(f.host.lib, 'probe', changed)).toThrow()
  const p = preview(f.host); expect(p.resetSchema).toBe(true)
  expect(p.removedKinds.map(k => k.id)).toContain(`probe:${template}`)
  await clean(f.host, p)
  expect(f.host.store.exists(template)).toBe(false)
  expect(f.host.store.blocksOf(id).body.data.text).toBe('retained')
  expect(f.host.lib.db.prepare("SELECT count(*) FROM kind_def WHERE json_extract(def,'$.plugin')='probe'").pluck().get()).toBe(0)
  expect(() => checkPackageKinds(f.host.lib, 'probe', changed)).not.toThrow()
  expect(f.host.reg.allKinds().some(k => k.plugin === 'probe')).toBe(false)
  expect(f.host.lib.db.prepare('SELECT count(*) FROM operation_receipt').pluck().get()).toBe(1)
  expect(f.host.lib.db.prepare("SELECT value FROM config WHERE key='plugins'").pluck().get()).toContain('probe')
})

it('旧声明只清理可核验的属性；未知混合数据与未授权记录保留，不能替别的插件认领记录', async () => {
  expect(() => validateDataLifecycle({ ...probe, dataLifecycle: { version: 1, disposableRecords: ['body'] } })).toThrow('本插件')
  expect(() => validateDataLifecycle({ ...probe, dataLifecycle: { version: 1, disposableRecords: ['mark'] } })).toThrow('独立记录')
  const f = setup({ ...probe, dataLifecycle: undefined })
  const record = f.host.api.create({ record: { title: 'legacy' } }) as string
  const asset = f.host.api.create({ body: { text: 'ok' }, mark: { text: 'remove' } }) as string
  f.host.lib.db.prepare('INSERT INTO main.block VALUES (?,?,?,?,?,?)').run(record, 'unknown', '{"text":"keep"}', 1, 100, 1)
  f.reopen()
  const p = preview(f.host); expect(p.retainedEffects.join()).toContain('未提供')
  await clean(f.host, p)
  expect(f.host.store.blocksOf(record).record).toBeDefined()
  expect(f.host.lib.db.prepare("SELECT data FROM block WHERE kind='unknown'").pluck().get()).toContain('keep')
  expect(f.host.store.blocksOf(asset).mark).toBeUndefined()
  expect((await f.host.api.previewPluginDataCleanup({ pluginId: 'file', mode: 'all' })).blocked.join()).toContain('必需')
})

it('预览后写入使令牌失效；SQL 失败完整回滚数据、历史与快照，缓存不先删除', async () => {
  const f = setup(), id = f.host.api.create({ body: { text: 'before' }, mark: { text: 'attribute' } }) as string
  f.host.lib.files.write('cache/a.txt', 'cached'); f.host.store.put(id, 'cached', { paths: ['cache/a.txt'] })
  f.reopen()
  const stale = preview(f.host)
  f.host.api.put(id, 'body', { text: 'after' })
  expect(() => clean(f.host, stale)).toThrow('PLUGIN_DATA_CHANGED')
  const before = f.host.lib.db.prepare('SELECT * FROM main.block ORDER BY kind').all()
  f.host.lib.db.exec("CREATE TRIGGER prevent_cleanup BEFORE DELETE ON main.kind_def WHEN old.id='mark' BEGIN SELECT RAISE(ABORT,'injected failure'); END")
  expect(() => clean(f.host)).toThrow('injected failure')
  expect(f.host.lib.db.prepare('SELECT * FROM main.block ORDER BY kind').all()).toEqual(before)
  expect(existsSync(join(f.root, 'cache/a.txt'))).toBe(true)
  expect(f.host.reg.kind('mark')).toBeDefined()
  f.host.lib.db.exec('DROP TRIGGER prevent_cleanup')
  await clean(f.host)
  expect(existsSync(join(f.root, 'cache/a.txt'))).toBe(false)
})

it('仅清理派生：保留持久块与定义、共享产物和缓存引用；失败候选跨重开重试，替换文件不误删', async () => {
  const f = setup(), id = f.host.api.create({ body: { text: 'base' }, mark: { text: 'keep' } }) as string
  for (const ref of ['cache/free', 'cache/shared', 'cache/failed', 'cache/replaced']) f.host.lib.files.write(ref, ref)
  f.host.store.put(id, 'cached', { paths: ['cache/free', 'cache/shared', 'cache/failed', 'cache/replaced'] })
  f.host.store.put(id, 'shared', { path: 'cache/shared' })
  f.reopen()
  const remove = vi.spyOn(f.host.lib.files, 'removeCache').mockImplementation(ref => { if (ref !== 'cache/free') throw new Error('busy'); rmSync(join(f.root, ref)) })
  const p = preview(f.host, 'derived'), result = await clean(f.host, p)
  expect(result.pendingCaches).toHaveLength(2)
  expect(f.host.store.blocksOf(id).mark).toBeDefined(); expect(f.host.store.blocksOf(id).shared).toBeDefined()
  expect(f.host.reg.kind('cached')).toBeDefined(); expect(existsSync(join(f.root, 'cache/shared'))).toBe(true)
  remove.mockRestore()
  f.host.lib.db.exec("UPDATE main.config SET value=json_remove(value, '$.result.removedKinds') WHERE key='pluginDataCleanup:probe'")
  f.reopen()
  f.host.lib.files.write('cache/replaced', 'new contents')
  const resumed = await f.host.api.retryPluginDataCleanup({ pluginId: 'probe' })
  expect(resumed.removedKinds).toEqual([]) // 旧回执没有明细，仍接续原任务。
  expect(resumed.pendingCaches).toEqual([]); expect(resumed.retainedCaches).toContain('cache/replaced')
  expect(existsSync(join(f.root, 'cache/failed'))).toBe(false)
  expect(existsSync(join(f.root, 'cache/replaced'))).toBe(true)
  expect(await clean(f.host, p)).toEqual(resumed)
})

it('相关跨插件历史整笔失效，独立历史仍可撤销；无当前块的历史也不能复活已清空定义', async () => {
  const f = setup(), id = f.host.api.create({ body: { text: 'base' } }) as string
  f.host.api.create({ record: { title: 'mixed stays' }, note: { text: 'foreign' } })
  f.reopen()
  // 模拟本会话存在的合法历史（例如宿主维护回放），不能靠重载恰巧清空历史来保证清理安全。
  f.host.history.run('mixed', () => { f.host.store.put(id, 'mark', { text: 'old' }, true); f.host.store.put(id, 'note', { text: 'part of mixed op' }) })
  f.host.history.run('remove mark', () => f.host.store.remove(id, 'mark', true))
  f.host.api.put(id, 'body', { text: 'changed' })
  const p = preview(f.host); expect(p.historyOperations).toBe(2); expect(p.resetSchema).toBe(false)
  await clean(f.host, p)
  expect((await f.host.api.listHistory()).entries).toHaveLength(1)
  f.host.api.undo()
  expect(f.host.store.blocksOf(id).body.data.text).toBe('base')
  expect(f.host.store.blocksOf(id).note.data.text).toBe('part of mixed op')
  expect(f.host.store.blocksOf(id).mark).toBeUndefined()
  expect(f.host.api.undo()).toBe(null)
})


it('加工者不拥有共享产物；缺少依赖而未装配的加工系统不阻止休眠数据清理', async () => {
  const f = setup({ ...probe, systems: [{ id: 'probe.shared', priority: 1, has: ['body'], needs: ['other'], outputs: ['shared'], async run() { return { shared: { path: 'cache/shared-output' } } } }] })
  const id = f.host.api.create({ body: { text: 'base' }, mark: { text: 'remove' } }) as string
  f.host.lib.files.write('cache/shared-output', 'shared')
  await f.host.scheduler.idle()
  f.reopen({ ...other, systems: [{ id: 'other.optional', priority: 1, has: ['body'], needs: ['probe'], outputs: ['cached'], async run() { throw new Error('缺依赖的加工不应运行') } }] })
  const p = preview(f.host)
  expect(p.blocked).toEqual([])
  expect(p.retainedEffects.join()).toContain('共享产物保留')
  await clean(f.host, p)
  expect(f.host.store.blocksOf(id).shared).toBeDefined()
  expect(existsSync(join(f.root, 'cache/shared-output'))).toBe(true)
})
