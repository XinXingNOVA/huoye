import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { versionHost, sharedVersionFile, prepareVersionEdit as prepare } from '../helpers/version-files'
import { saveTextFile } from '../helpers/helpers'
import { filePlugin } from '../../src/plugins/file/core'
import type { CorePlugin } from '../../src/core/plugin'
import { SpaceVersions, setVersionPermission } from '../../src/storage/space-versions'
import type { CommitFileEdit, FileEditPreview } from '../../src/shared/file-edits'
const cleanups: (() => void)[] = []
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f() })
async function fixture() {
  const f = await sharedVersionFile(cleanups, '# original', 'test.md')
  const privateSpace = SpaceVersions.create(join(f.dir, 'private'), 'private'); cleanups.push(() => privateSpace.space.close())
  f.a.api.linkFileSpace(privateSpace.space.root)
  return { ...f, id: f.ai, bid: f.bi, shared: f.versions, privateSpace }
}
const content = (h: Awaited<ReturnType<typeof fixture>>['a'], id: string) => readFileSync(h.lib.files.readable(String(h.store.blocksOf(id).file.data.path)), 'utf8')
const commit = (p: FileEditPreview): CommitFileEdit => ({ editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() })
it('异步文本编辑、发布、重复准备与提交；其他库沿用旧版，业务数据保留', async () => {
  const { a, b, id, bid, shared } = await fixture()
  a.api.put(id, 'note', { text: 'keep' })
  const input = { id, destination: { mode: 'publish' as const }, content: { type: 'text' as const, text: '# new' }, requestId: randomUUID() }
  const p = await a.api.prepareFileEdit(input), request = commit(p)
  expect(content(a, id)).toBe('# original')
  expect(await a.api.prepareFileEdit(input)).toEqual(p)
  await expect(a.api.prepareFileEdit({ ...input, content: { type: 'text', text: 'changed' } })).rejects.toThrow('REQUEST_ID_CONFLICT')
  const result = await a.api.commitFileEdit(request)
  expect(result.library.state).toBe('accepted'); expect(content(a, id)).toBe('# new'); expect(content(b, bid)).toBe('# original')
  expect(a.store.blocksOf(id).note.data.text).toBe('keep')
  expect((await a.api.commitFileEdit(request)).space.contentVersion).toBe(result.space.contentVersion)
  expect(shared.versions(result.space.fileId)).toHaveLength(2)
  await a.scheduler.idle(); expect(a.store.blocksOf(id).body.data.content).toContain('# new')
})
it('独立副本落在新版独享空间；原件不变，保留素材，后续自动收录不重复', async () => {
  const { a, b, id, bid, privateSpace } = await fixture()
  const settings = await a.api.getImportSettings()
  a.api.setImportSettings({ defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId: privateSpace.space.id, automatic: true, updates: 'manual' }] })
  const p = await a.api.prepareFileEdit({ id, destination: { mode: 'copy', spaceId: privateSpace.space.id }, content: { type: 'text', text: '# independent' }, requestId: randomUUID() })
  expect((await a.api.commitFileEdit(commit(p))).library.state).toBe('accepted')
  expect(content(a, id)).toBe('# independent'); expect(content(b, bid)).toBe('# original')
  await a.api.scanSpaceImports(); expect((await a.api.query({ has: ['file'] })).ids).toEqual([id])
  expect(String(a.store.blocksOf(id).file.data.path)).toContain(`spaces/v2/${privateSpace.space.id}/`)
})
it('目标变化、撤权、模式变化都拒绝；本地与 MCP 编辑隔离，放弃不能发布', async () => {
  const { a, b, id, shared, privateSpace } = await fixture()
  const input = { id, destination: { mode: 'publish' as const }, content: { type: 'text' as const, text: '# new' }, requestId: randomUUID() }
  expect((await b.api.listFileSpaces()).find(s => s.id === shared.space.id)?.canRevise).toBe(false)
  setVersionPermission(shared.space, a.lib.id, 'revise', false, shared.space.info().revision)
  await expect(a.api.prepareFileEdit(input)).rejects.toThrow('SPACE_REVISE_DENIED')
  setVersionPermission(shared.space, a.lib.id, 'revise', true, shared.space.info().revision)
  const p = await a.api.prepareFileEdit(input)
  await expect(a.api.externalFileAction({ action: 'commit', input: commit(p) })).rejects.toThrow('EDIT_SCOPE')
  setVersionPermission(shared.space, a.lib.id, 'revise', false, shared.space.info().revision)
  await expect(a.api.commitFileEdit(commit(p))).rejects.toThrow('SPACE_REVISE_DENIED')
  setVersionPermission(shared.space, a.lib.id, 'revise', true, shared.space.info().revision)
  a.api.patch(id, 'file', { name: 'new-name.md' })
  await expect(a.api.commitFileEdit(commit(p))).rejects.toThrow('REQUEST_ID_CONFLICT') // 已失败提交也固定原意图
  const other = await a.api.prepareFileEdit({ ...input, requestId: randomUUID(), destination: { mode: 'copy', spaceId: privateSpace.space.id } })
  privateSpace.space.changeMode('shared', privateSpace.space.info().revision)
  await expect(a.api.commitFileEdit(commit(other))).rejects.toThrow('COPY_TARGET_CHANGED')
  a.api.discardFileEdit({ editId: other.editId, requestId: randomUUID() })
  await expect(a.api.commitFileEdit(commit(other))).rejects.toThrow('EDIT_NOT_READY')
})
it.each(['publish', 'copy'] as const)('%s 仓库写入失败保留回执；重开不重复发布，副本不被自动收录', async mode => {
  const { a, b, id, bid, shared, privateSpace } = await fixture(), root = a.lib.root
  const settings = await a.api.getImportSettings()
  a.api.setImportSettings({ defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId: privateSpace.space.id, automatic: true, updates: 'manual' }] })
  const p = await a.api.prepareFileEdit({ id, destination: mode === 'copy' ? { mode, spaceId: privateSpace.space.id } : { mode }, content: { type: 'text', text: '# recover' }, requestId: randomUUID() }), request = commit(p)
  a.lib.db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON block WHEN NEW.kind='file' BEGIN SELECT RAISE(ABORT,'injected'); END")
  expect((await a.api.commitFileEdit(request)).library.state).toBe('pending')
  await a.api.scanSpaceImports(); expect((await a.api.query({ has: ['file'] })).ids).toEqual([id])
  a.lib.db.exec('DROP TRIGGER deny_update'); a.close()
  const reopened = versionHost(cleanups, root)
  await reopened.api.scanSpaceImports(); expect(content(reopened, id)).toBe('# recover')
  expect((await reopened.api.commitFileEdit(request)).library.state).toBe('accepted')
  expect(content(b, bid)).toBe('# original')
  const target = mode === 'copy' ? privateSpace : shared
  expect(target.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()).toBe(mode === 'copy' ? 1 : 2)
})
it('准备后只修改笔记不会阻止发布；同路径文件 seq 变化保护编辑基线', async () => {
  const { a, id } = await fixture()
  const p = await a.api.prepareFileEdit({ id, destination: { mode: 'publish' }, content: { type: 'text', text: '# new' }, requestId: randomUUID() })
  a.api.put(id, 'note', { text: 'late note' }); await a.api.commitFileEdit(commit(p))
  expect(a.store.blocksOf(id).note.data.text).toBe('late note')
  const next = await a.api.prepareFileEdit({ id, destination: { mode: 'publish' }, content: { type: 'text', text: '# third' }, requestId: randomUUID() })
  a.api.patch(id, 'file', { name: 'renamed.md' })
  await expect(a.api.commitFileEdit(commit(next))).rejects.toThrow('ITEM_CHANGED')
})
it('取消准备后可同参重试；放弃草稿不改变空间当前版', async () => {
  const { a, id, shared } = await fixture()
  const request = { id, destination: { mode: 'publish' as const }, content: { type: 'text' as const, text: '# cancel' }, requestId: randomUUID() }
  const task = a.api.prepareFileEdit(request)
  a.api.cancelFileEdit(request.requestId)
  await expect(task).rejects.toThrow()
  const p = await a.api.prepareFileEdit(request)
  a.api.discardFileEdit({ editId: p.editId, requestId: randomUUID() })
  await expect(a.api.prepareFileEdit(request)).rejects.toThrow('EDIT_DISCARDED')
  expect(content(a, id)).toBe('# original')
  expect(shared.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()).toBe(1)
})

it('可编辑格式依据受控文件快照，用户显示名称不改变格式', async () => {
  const { a, id } = await fixture()
  a.api.patch(id, 'file', { name: '无扩展名的显示标题' })
  const p = await a.api.prepareFileEdit({ id, destination: { mode: 'publish' }, content: { type: 'text', text: '# unchanged format' }, requestId: randomUUID() })
  await a.api.commitFileEdit(commit(p))
  expect(a.store.blocksOf(id).file.data).toMatchObject({ name: '无扩展名的显示标题', ext: 'md', mime: 'text/markdown' })
  expect(content(a, id)).toBe('# unchanged format')
})
it('按准备请求放弃失败提交，已发布编辑不能伪装为放弃；编辑器旧快照被拒绝', async () => {
  const { a, id, shared } = await fixture(), file = a.store.blocksOf(id).file
  const input = { id, destination: { mode: 'publish' as const }, content: { type: 'text' as const, text: '# draft' }, requestId: randomUUID() }
  await expect(a.api.prepareFileEdit({ ...input, expectedSeq: file.seq + 1 })).rejects.toThrow('FILE_CHANGED')
  const request = { ...input, requestId: randomUUID() }, p = await a.api.prepareFileEdit(request)
  setVersionPermission(shared.space, a.lib.id, 'revise', false, shared.space.info().revision)
  await expect(a.api.commitFileEdit(commit(p))).rejects.toThrow('SPACE_REVISE_DENIED')
  a.api.discardFileEdit({ prepareRequestId: request.requestId, requestId: randomUUID() })
  await expect(a.api.prepareFileEdit(request)).rejects.toThrow('EDIT_DISCARDED')
  setVersionPermission(shared.space, a.lib.id, 'revise', true, shared.space.info().revision)
  const next = await a.api.prepareFileEdit({ ...input, requestId: randomUUID() })
  await a.api.commitFileEdit(commit(next))
  expect(() => a.api.discardFileEdit({ editId: next.editId, requestId: randomUUID() })).toThrow('已发布')
})

it('草稿不能被其他仓库借用；未发布重试仍核对本库目标，不能借回执占位绕过', async () => {
  const {a,b,id:ai,bid:bi,source,shared:versions}=await fixture()
  writeFileSync(source,'# version-two');const request=await prepare(a,ai,source)
  await expect(b.api.commitFileEdit(request)).rejects.toThrow('NOT_FOUND')
  // 第一次发布失败留下本库用例；之后主动独立化不得再次修改旧共享原件。
  versions.space.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON version_receipts WHEN NEW.requestId='"+request.requestId+"' BEGIN SELECT RAISE(ABORT,'simulate publish failure'); END")
  await expect(a.api.commitFileEdit(request)).rejects.toThrow('simulate publish failure')
  versions.space.db.exec('DROP TRIGGER fail_publish')
  await a.api.makeFileIndependent(ai)
  await expect(a.api.commitFileEdit(request)).rejects.toThrow('ITEM_CHANGED')
  expect(content(b,bi)).toBe('# original')
})

it('两个仓库准备相同基线时仅先提交者成功，冲突草稿保留', async () => {
  const { a, b, id, bid, shared, source } = await fixture()
  setVersionPermission(shared.space, b.lib.id, 'revise', true, shared.space.info().revision)
  writeFileSync(source, '# concurrent')
  const one = await prepare(a, id, source), two = await prepare(b, bid, source)
  await a.api.commitFileEdit(one)
  await expect(b.api.commitFileEdit(two)).rejects.toThrow('VERSION_CONFLICT')
  expect(content(b, bid)).toBe('# original')
  // 失败的本库意图和空间草稿保留，仍可显式放弃。
  b.api.discardFileEdit({ editId: two.editId, requestId: randomUUID() })
})

async function sample(plugins?: CorePlugin[]) {
  const host = versionHost(cleanups, undefined, plugins)
  const [id] = await host.api.ingest([{ type: 'bytes', name: 'source.md', bytes: new TextEncoder().encode('# original') }])
  await host.scheduler.idle()
  return { host, id, before: host.store.blocksOf(id).file.data }
}

it('版本副本沿用回执，仓库撤销不覆盖版本字节；数据块改名仍可撤销', async () => {
  const h = await sample(), { host, id, before } = h
  const alias = await host.api.create({ file: before })
  host.api.trash([alias])
  const requestId = randomUUID()
  const result = await host.api.makeFileIndependent(id, undefined, requestId)
  expect(result.library.state).toBe('accepted')
  const copy = String(host.store.blocksOf(id).file.data.path)
  expect(copy).not.toBe(before.path)
  expect((await host.api.makeFileIndependent(id, undefined, requestId)).space).toEqual(result.space)
  await saveTextFile(host, id, '# new')
  const edited = String(host.store.blocksOf(id).file.data.path)
  host.api.run('file', 'rename', { names: { [id]: 'display name' } })
  expect(host.store.blocksOf(id).file.data.path).toBe(edited)
  host.api.undo()
  expect(host.store.blocksOf(id).file.data.name).toBe('source.md')
  expect(host.store.blocksOf(id).file.data.path).toBe(edited)
  expect(readFileSync(host.lib.files.readable(edited), 'utf8')).toBe('# new')
  expect(readFileSync(host.lib.files.readable(copy), 'utf8')).toBe('# original')
  expect(readFileSync(host.lib.files.readable(String(before.path)), 'utf8')).toBe('# original')
  expect(host.store.blocksOf(alias).file.data).toEqual(before)
  host.api.put(id, 'note', { text: 'independent history' }); host.api.undo()
  expect(host.store.blocksOf(id).file.data.path).toBe(edited)
})

it('版本编辑回到同一哈希时，在途加工仍检查最新文件块序号', async () => {
  let hold = false, started!: () => void, release!: () => void
  const began = new Promise<void>(r => { started = r }), gate = new Promise<void>(r => { release = r })
  const parser: CorePlugin = { id: 'parser', version: 1,
    blocks: [{ id: 'parsed', plugin: 'parser', title: '解析', version: 1, rebuildable: true, fields: { source: { type: 'number', title: '来源序号' } } }],
    systems: [{ id: 'parser.read', priority: 1, has: ['file'], inputs: ['file.hash'], outputs: ['parsed'], async run(_ctx, _id, b) {
      if (hold) { hold = false; started(); await gate }
      return { parsed: { source: b.file.seq } }
    } }]
  }
  const { host, id } = await sample([filePlugin, parser])
  try {
    hold = true
    await saveTextFile(host, id, '# B'); await began
    await saveTextFile(host, id, '# original')
    await saveTextFile(host, id, '# B')
  } finally { release() }
  await host.scheduler.idle()
  const blocks = host.store.blocksOf(id)
  expect(blocks.parsed.data.source).toBe(blocks.file.seq)
})
