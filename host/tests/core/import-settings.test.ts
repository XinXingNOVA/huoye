import { afterEach, expect, it } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { openHost } from '../helpers/helpers'
import { parseSpaceReference } from '../../src/storage/space-reference'
import { FileSpace } from '../../src/storage/file-space'
import { FileImport } from '../../src/storage/library-files'
import { filePlugin } from '../../src/plugins/file/core'
import { plugin as note } from '@test-plugins/note/core'
import { plugin as source } from '@test-plugins/source/core'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'
const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function setup(plugins?: CorePlugin[]) { const h = openHost(plugins); cleanup.push(h.cleanup); return h }
function shared() { const dir = mkdtempSync(join(tmpdir(), 'rm-imports-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return { ...FileSpace.create(join(dir, 'space'), 'shared'), dir } }
function input(root: string, name = 'input.md', text = '# new content') { const path = join(root, name); writeFileSync(path, text); return path }
async function add(root: string, name: string) {
  const path = input(root, name, name), space = new FileSpace(root), staged = new FileImport(space, name)
  try { const f = await staged.stage('test', path, name); return space.byId(parseSpaceReference(f.reference)!.fileId)! } finally { staged.dispose(); space.close() }
}
async function settings(h: ReturnType<typeof setup>, patch: object) { const { bindings: _, ...old } = await h.host.api.getImportSettings(); return h.host.api.setImportSettings({ ...old, ...patch }) }
it('默认沿用保存并收录；单次覆盖与仓库持久配置独立，历史操作保持收录语义', async () => {
  const h = setup(), s = shared(); h.host.api.linkFileSpace(s.root)
  const path = input(h.root), original = await h.host.api.getImportSettings()
  expect(original.collect).toBe(true)
  await settings(h, { collect: false })
  const r = await h.host.api.importToLibrary([{ type: 'file', path }], { requestId: 'once-override', spaceId: s.id, collect: true })
  expect(r.items).toHaveLength(1); expect(r.spaceId).toBe(s.id)
  expect((await h.host.api.getImportSettings()).defaultSpaceId).toBe(original.defaultSpaceId)
  const legacy = await h.host.api.executeOperation({ operation: 'import_files', requestId: 'legacy-still-collects', args: { paths: [path] } })
  expect((legacy.result as any).items).toHaveLength(1)
  h.host.close(); const next = openHost(undefined, undefined, h.root); cleanup.push(() => next.host.close())
  expect((await next.host.api.getImportSettings()).collect).toBe(false)
})
it('只保存不创建素材；同批和后续重复复用文件，延迟收录保留来源与附加数据', async () => {
  const h = setup([filePlugin, note, source]), path = input(h.root)
  await settings(h, { collect: false })
  const r = await h.host.api.importToLibrary([{ type: 'file', path, source: { url: 'https://example.com/book' }, metadata: { 'note.initial': { text: '稍后收录的笔记' } } }, { type: 'file', path }], { requestId: 'save-no-materials' })
  expect(r.saved).toHaveLength(2); expect(r.items).toEqual([]); expect((await h.host.api.query({})).ids).toEqual([])
  const again = await h.host.api.importToLibrary([{ type: 'file', path }], { requestId: 'save-no-duplicates' })
  expect(again.saved[0].fileId).toBe(r.saved[0].fileId); expect(again.saved[0].outcome).toBe('existing')
  const p = await h.host.api.listSpaceFiles({ spaceId: r.spaceId! }); expect(p.total).toBe(1)
  const adopted = await h.host.api.adoptSpaceFiles({ spaceId: r.spaceId!, requestId: 'manual-adopt-saved', files: [{ id: p.items[0].id, revision: p.items[0].revision }] })
  const id = (adopted.result as any).items[0].id
  expect(h.host.store.blocksOf(id).note.data.text).toBe('稍后收录的笔记')
  expect(h.host.store.blocksOf(id).source.data.url).toBe('https://example.com/book')
})
it('纯文字仍入仓库；字节输入只保存也可随后收录，逐项错误不掩盖成功', async () => {
  const h = setup(); await settings(h, { collect: false })
  const r = await h.host.api.importToLibrary([{ type: 'text', text: '独立的文字' }, { type: 'bytes', name: '粘贴.txt', bytes: new TextEncoder().encode('clipboard') }, { type: 'file', path: join(h.root, 'missing.txt') }], { requestId: 'mixed-inputs-save' })
  // MCP 路径导入逐项报告错误，UI 文件夹展开也应保留有效输入。
  expect(r.items).toHaveLength(1); expect(r.saved).toHaveLength(1); expect(r.errors).toHaveLength(1)
})
it('自动收录只处理启用后的新身份，不回填存量；撤销、回收、重新启用与重启不复活', async () => {
  const s = shared(), old = await add(s.root, 'old.md'), a = setup(), b = setup()
  a.host.api.linkFileSpace(s.root); b.host.api.linkFileSpace(s.root)
  await settings(a, { spaces: [{ spaceId: s.id, automatic: true }] })
  const fresh = await add(s.root, 'fresh.md')
  expect((await a.host.api.scanSpaceImports()).collected).toBe(1)
  expect((await b.host.api.scanSpaceImports()).collected).toBe(0)
  const page = await a.host.api.listSpaceFiles({ spaceId: s.id })
  expect(page.items.find(f => f.id === old.id)!.collected).toBeUndefined()
  const id = page.items.find(f => f.id === fresh.id)!.collected!
  a.host.api.undo(); expect(a.host.store.isTrashed(id)).toBe(true)
  expect((await a.host.api.scanSpaceImports()).collected).toBe(0)
  await settings(a, { spaces: [{ spaceId: s.id, automatic: false }] }); await settings(a, { spaces: [{ spaceId: s.id, automatic: true }] })
  a.host.close(); const next = openHost(undefined, undefined, a.root); cleanup.push(() => next.host.close())
  expect((await next.host.api.scanSpaceImports()).collected).toBe(0); expect(next.host.store.isTrashed(id)).toBe(true)
})
it('本仓库只保存决定优先于自动收录；其他仓库仍按各自策略收录', async () => {
  const s = shared(), a = setup(), b = setup(); a.host.api.linkFileSpace(s.root); b.host.api.linkFileSpace(s.root)
  for (const h of [a, b]) await settings(h, { defaultSpaceId: s.id, spaces: [{ spaceId: s.id, automatic: true }] })
  const r = await a.host.api.importToLibrary([{ type: 'file', path: input(a.root) }], { requestId: 'explicit-save-only', collect: false })
  expect((await a.host.api.scanSpaceImports()).collected).toBe(0); expect((await b.host.api.scanSpaceImports()).collected).toBe(1)
  expect((await a.host.api.listSpaceFiles({ spaceId: s.id })).items[0].collected).toBeUndefined()
  expect(r.items).toEqual([])
})
it('失败重试固定首次目标和策略，自动发现不能抢先提交失败的附加业务', async () => {
  let fail = true
  const plugin: CorePlugin = { id: 'guard', version: 1, ingestMetadata: [{ id: 'guard.apply', title: '检查', description: 'test', input: z.object({}).strict(), apply() { if (fail) throw Error('暂不能收录'); return { status: 'unchanged' } } }] }
  const h = setup([filePlugin, plugin]), s = shared(); h.host.api.linkFileSpace(s.root)
  await settings(h, { defaultSpaceId: s.id, spaces: [{ spaceId: s.id, automatic: true }] })
  const path = input(h.root), request = { requestId: 'retry-keeps-policy' }, inputs = [{ type: 'file' as const, path, metadata: { 'guard.apply': {} } }]
  await expect(h.host.api.importToLibrary(inputs, request)).rejects.toThrow('FILE_STORED_NOT_ADOPTED')
  expect((await h.host.api.scanSpaceImports()).collected).toBe(0)
  const embedded = (await h.host.api.listFileSpaces()).find(s => s.embedded)!
  await settings(h, { defaultSpaceId: embedded.id, collect: false })
  fail = false
  const r = await h.host.api.importToLibrary(inputs, request)
  expect(r.spaceId).toBe(s.id); expect(r.collect).toBe(true); expect(r.items).toHaveLength(1)
  h.host.api.undo(); expect(await h.host.api.importToLibrary(inputs, request)).toEqual(r)
  expect(h.host.store.isTrashed(r.items[0].id)).toBe(true)
  await expect(h.host.api.importToLibrary(inputs, { ...request, collect: false })).rejects.toThrow('REQUEST_ID_CONFLICT')
})
it('未知空间与离线目标不回退；自动收录失败可重试，不篡改其他空间配置', async () => {
  const s = shared(), h = setup(); h.host.api.linkFileSpace(s.root)
  await settings(h, { defaultSpaceId: s.id, spaces: [{ spaceId: s.id, automatic: true }] })
  const file = await add(s.root, 'later.md'), path = join(s.root, file.path)
  renameSync(path, path + '.away')
  expect((await h.host.api.scanSpaceImports()).errors).toHaveLength(1)
  renameSync(path + '.away', path)
  expect((await h.host.api.scanSpaceImports()).collected).toBe(1)
  renameSync(s.root, s.root + '-offline')
  await expect(h.host.api.importToLibrary([{ type: 'file', path: input(h.root) }], { requestId: 'offline-rejected' })).rejects.toThrow('FILE_SPACE_OFFLINE')
  renameSync(s.root + '-offline', s.root)
  const bytes = readFileSync(path); expect(bytes.toString()).toBe('later.md')
})
it('只保存后再次主动收录复用空间文件，保留多次保存的附加意图', async () => {
  const { plugin: tags } = await import('@test-plugins/tags/core')
  const h = setup([filePlugin, tags, note]), path = input(h.root)
  const options = { collect: false, requestId: 'saved-first-tags' }
  const first = await h.host.api.importToLibrary([{ type: 'file', path, metadata: { 'tags.add': { add: ['第一批'] } } }], options)
  await h.host.api.importToLibrary([{ type: 'file', path, metadata: { 'tags.add': { add: ['第二批'] } } }], { ...options, requestId: 'saved-second-tags' })
  const final = await h.host.api.importToLibrary([{ type: 'file', path }], { requestId: 'collect-saved-again', collect: true })
  expect(final.saved[0].fileId).toBe(first.saved[0].fileId)
  expect(final.saved[0].outcome).toBe('existing')
  expect((await h.host.api.listSpaceFiles({ spaceId: first.spaceId! })).total).toBe(1)
  expect(h.host.store.blocksOf(final.items[0].id).tags.data.values).toEqual(['第一批', '第二批'])
})
it('正在复制的导入固定已选择的空间，不随配置修改转移目标', async () => {
  let started!: () => void, release!: () => void
  const entered = new Promise<void>(r => { started = r }), gate = new Promise<void>(r => { release = r })
  const recognizer = filePlugin.recognizers![0]
  const delayed = { ...filePlugin, recognizers: [{ ...recognizer, async ingest(ctx: Parameters<typeof recognizer.ingest>[0], value: Parameters<typeof recognizer.ingest>[1]) { started(); await gate; return recognizer.ingest(ctx, value) } }] }
  const h = setup([delayed]), s = shared(); h.host.api.linkFileSpace(s.root)
  const before = await h.host.api.getImportSettings()
  const task = h.host.api.importToLibrary([{ type: 'file', path: input(h.root) }], { requestId: 'in-flight-default' })
  await entered; await settings(h, { defaultSpaceId: s.id, collect: false }); release()
  const result = await task
  expect(result.spaceId).toBe(before.defaultSpaceId); expect(result.collect).toBe(true)
  expect((await h.host.api.listSpaceFiles({ spaceId: s.id })).total).toBe(0)
})
it('每次最多尝试 100 项，失败文件不阻塞后续尚未尝试的新文件', async () => {
  const h = setup(), s = shared(); h.host.api.linkFileSpace(s.root)
  await settings(h, { spaces: [{ spaceId: s.id, automatic: true }] })
  const originals: string[] = []
  for (let i = 0; i < 101; i++) { const file = await add(s.root, `bad-${i}.txt`); originals.push(join(s.root, file.path)) }
  for (const path of originals) rmSync(path)
  const good = await add(s.root, 'good.md')
  const first = await h.host.api.scanSpaceImports(); expect(first.collected).toBe(0); expect(first.remaining).toBe(102)
  const next = await h.host.api.scanSpaceImports(); expect(next.collected).toBe(1)
  const page = await h.host.api.listSpaceFiles({ spaceId: s.id, limit: 100, offset: 0 })
  // 使用持久收录映射校验，不依赖 UUID 排序恰好落在哪一页。
  expect(h.host.lib.db.prepare('SELECT entity_id FROM space_adoptions WHERE space_id=? AND file_id=?').get(s.id, good.id)).toBeTruthy()
  expect(page.total).toBe(102)
})
