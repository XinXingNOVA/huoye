import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'
import { FileSpace } from '../../src/storage/file-space'
import { SpaceVersions, setVersionPermission, versionPermissions } from '../../src/storage/space-versions'
import { SpaceLifecycle } from '../../src/storage/space-lifecycle'
import { SpaceHistory } from '../../src/storage/space-history'
import { serveLibraryFile } from '../../src/main/lib-protocol'
import type { SpaceMutationInput } from '../../src/shared/file-spaces'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) fn() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-version-life-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const versions = SpaceVersions.create(join(dir, 'space'), 'shared'); cleanups.push(() => versions.space.close())
  const ah = openHost(), bh = openHost(); cleanups.push(ah.cleanup, bh.cleanup)
  const a = ah.host, b = bh.host, space = versions.space, spaceId = space.id, source = join(dir, 'document.md')
  a.api.linkFileSpace(space.root); b.api.linkFileSpace(space.root)
  setVersionPermission(space, a.lib.id, 'revise', true, space.info().revision)
  writeFileSync(source, '# version-one')
  const imported = await a.api.importToLibrary([{ type: 'file', path: source }], { spaceId, requestId: randomUUID() })
  const ai = imported.items[0].id, file = (await a.api.listSpaceFiles({ spaceId })).items[0]
  const adopted = await b.api.adoptSpaceFiles({ spaceId, files: [{ id: file.id, revision: file.revision }], requestId: randomUUID() })
  const bi = (adopted.result as { items: { id: string }[] }).items[0].id
  const v1 = versions.head(file.id)
  writeFileSync(source, '# version-two')
  const p = await a.api.prepareFileEdit({ id: ai, content: { type: 'file', path: source }, destination: { mode: 'publish' }, requestId: randomUUID() })
  await a.api.commitFileEdit({ editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() })
  await Promise.all([a.scheduler.idle(), b.scheduler.idle()])
  a.api.put(ai, 'note', { text: 'A 笔记' }); b.api.put(bi, 'note', { text: 'B 笔记' })
  const ref = (h: typeof a, id: string) => String(h.store.blocksOf(id).file.data.path)
  const mutation = (action: 'recycle' | 'restore'): SpaceMutationInput => ({ spaceId, action, files: [{ id: file.id, revision: space.byId(file.id)!.revision }], version: space.info().revision, requestId: randomUUID() })
  const history = () => ({ spaceId, fileId: file.id, contentVersion: v1, revision: space.byId(file.id)!.revision, requestId: randomUUID() })
  return { dir, space, versions, source, a, b, ai, bi, fileId: file.id, v1, ref, mutation, history }
}

it('回收授权独立于更新；共享回收拒绝所有已接纳版本，原件恢复不复活仓库素材', async () => {
  const f = await fixture(), { a, b, ai, bi, space, versions, fileId, ref } = f
  expect(versionPermissions(space).members.find(m => m.id === a.lib.id)).toMatchObject({ revise: true, recycle: false })
  expect((await a.api.previewSpaceMutation({ spaceId: space.id, action: 'recycle', files: [{ id: fileId, revision: space.byId(fileId)!.revision }] })).blocked).toContain('SPACE_RECYCLE_DENIED')
  await expect(a.api.mutateSpaceFiles(f.mutation('recycle'))).rejects.toThrow('SPACE_RECYCLE_DENIED')
  setVersionPermission(space, a.lib.id, 'recycle', true, space.info().revision)
  const recycle = f.mutation('recycle'), oldA = ref(a, ai), oldB = ref(b, bi)
  const before = versions.changes().length
  await a.api.mutateSpaceFiles(recycle)
  expect(versions.changes().slice(before).map(c => c.type)).toEqual(['recycled'])
  for (const [h, path] of [[a, oldA], [b, oldB]] as const) {
    expect(() => h.lib.files.readable(path)).toThrow(/UNAVAILABLE|RECYCLED/)
    expect((await serveLibraryFile(h.lib.root, new Request(`lib://library/${path}`))).status).toBe(403)
  }
  expect(() => versions.read(fileId, f.v1)).toThrow('FILE_UNAVAILABLE')
  expect((await a.api.listSpaceFiles({ spaceId: space.id, scope: 'recycled' })).items[0].lifecycle).toBe('recycled')
  b.api.trash([bi])
  const settings = await b.api.getImportSettings()
  b.api.setImportSettings({ defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId: space.id, automatic: true, updates: 'automatic' }] })
  expect((await b.api.scanSpaceImports()).errors).toEqual([])
  await a.api.mutateSpaceFiles(f.mutation('restore'))
  await b.api.scanSpaceImports()
  expect(b.store.isTrashed(bi)).toBe(true)
  expect(readFileSync(b.lib.files.readable(oldB), 'utf8')).toBe('# version-one')
  expect(b.store.blocksOf(bi).note.data.text).toBe('B 笔记')
  expect((await a.api.mutateSpaceFiles(recycle)).replayed).toBe(true)
  expect(space.byId(fileId)!.state).toBe('available')
  expect(space.db.prepare('SELECT version FROM space').pluck().get()).toBe(4)
  expect(versions.versions(fileId)).toHaveLength(2)
})

it('过期预览与撤回授权拒绝提交；仓库不能借用其他成员回执', async () => {
  const f = await fixture(), { a, b, space } = f
  setVersionPermission(space, a.lib.id, 'recycle', true, space.info().revision)
  const stale = f.mutation('recycle')
  setVersionPermission(space, a.lib.id, 'recycle', false, space.info().revision)
  await expect(a.api.mutateSpaceFiles(stale)).rejects.toThrow('SPACE_RECYCLE_DENIED')
  setVersionPermission(space, a.lib.id, 'recycle', true, space.info().revision)
  await expect(a.api.mutateSpaceFiles(stale)).rejects.toThrow('SPACE_CHANGED')
  const input = f.mutation('recycle'); await a.api.mutateSpaceFiles(input)
  setVersionPermission(space, b.lib.id, 'recycle', true, space.info().revision)
  await expect(b.api.mutateSpaceFiles(input)).rejects.toThrow('REQUEST_ID_CONFLICT')
  await expect(a.api.mutateSpaceFiles({ ...input, action: 'restore' })).rejects.toThrow('REQUEST_ID_CONFLICT')
})

it('应用独立入口可恢复；重开重放不重复改变生命周期，恢复不会把未收录文件当新增', async () => {
  const f = await fixture(), { a, space, source } = f
  writeFileSync(source, '# uncollected')
  const added = await a.api.importToLibrary([{ type: 'file', path: source }], { spaceId: space.id, collect: false, requestId: randomUUID() })
  expect(added.items).toHaveLength(0)
  const candidate = (await a.api.listSpaceFiles({ spaceId: space.id })).items.find(i => !i.collected)!
  const request = { ...f.mutation('recycle'), files: [{ id: candidate.id, revision: candidate.revision }] }
  const preview = new SpaceLifecycle(space).preview({ spaceId: request.spaceId, action: request.action, files: request.files })
  expect(preview.references.scope).toBe('unchecked')
  await new SpaceLifecycle(space).execute(request)
  const settings = await a.api.getImportSettings()
  a.api.setImportSettings({ defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId: space.id, automatic: true, updates: 'manual' }] })
  const reopened = new FileSpace(space.root)
  try {
    const service = new SpaceLifecycle(reopened)
    await service.execute({ ...request, action: 'restore', files: [{ id: candidate.id, revision: reopened.byId(candidate.id)!.revision }], version: reopened.info().revision, requestId: randomUUID() })
    expect((await service.execute(request)).replayed).toBe(true)
  } finally { reopened.close() }
  await a.api.scanSpaceImports()
  expect((await a.api.listSpaceFiles({ spaceId: space.id })).items.find(i => i.id === candidate.id)!.collected).toBeUndefined()
})

it('回收与发布互斥；准备好的旧草稿不能在回收或恢复后提交', async () => {
  const f = await fixture(), { a, ai, space, source } = f
  setVersionPermission(space, a.lib.id, 'recycle', true, space.info().revision)
  writeFileSync(source, '# next')
  const p = await a.api.prepareFileEdit({ id: ai, content: { type: 'file', path: source }, destination: { mode: 'publish' }, requestId: randomUUID() })
  await a.api.mutateSpaceFiles(f.mutation('recycle')); await a.api.mutateSpaceFiles(f.mutation('restore'))
  await expect(a.api.commitFileEdit({ editId: p.editId, previewToken: p.previewToken, requestId: randomUUID() })).rejects.toThrow('VERSION_CONFLICT')
})

it('批量恢复校验全部历史字节；任一旧版损坏则整批维持回收，取消也不提交', async () => {
  const f = await fixture(), { versions, space, source, fileId, v1 } = f
  const added = await versions.stage({ spaceId: space.id, source, requestId: randomUUID() }), p = versions.preview(added.draft.id)
  const other = await versions.commit({ spaceId: space.id, draftId: p.draft.id, previewToken: p.previewToken, requestId: randomUUID() })
  const lifecycle = new SpaceLifecycle(space), badPath = versions.read(fileId, v1)
  await lifecycle.execute({ ...f.mutation('recycle'), files: [fileId, other.fileId].map(id => ({ id, revision: space.byId(id)!.revision })) })
  const restore = { ...f.mutation('restore'), files: [fileId, other.fileId].map(id => ({ id, revision: space.byId(id)!.revision })) }
  const controller = new AbortController(); controller.abort()
  await expect(versions.mutateLifecycle(restore, { signal: controller.signal })).rejects.toThrow()
  writeFileSync(badPath, '# corrupt-old')
  await expect(lifecycle.execute(restore)).rejects.toThrow('FILE_CHANGED')
  expect(space.byId(fileId)!.state).toBe('recycled'); expect(space.byId(other.fileId)!.state).toBe('recycled')
  expect(versions.changes().at(-1)!.type).toBe('recycled')
})

it('历史恢复新增 V3，保留 V1/V2，各库按策略接纳；回收状态不允许恢复历史', async () => {
  const f = await fixture(), { a, b, ai, bi, space, versions, fileId, ref } = f
  const request = f.history(), before = ref(a, ai)
  const result = await a.api.restoreSpaceVersion(request)
  expect(result.contentVersion).not.toBe(f.v1)
  expect(versions.versions(fileId).map(v => v.ordinal)).toEqual([3, 2, 1])
  expect(readFileSync(versions.read(fileId, result.contentVersion), 'utf8')).toBe('# version-one')
  expect(ref(a, ai)).toBe(before) // 当前库手动接纳，无隐含换版。
  expect((await a.api.scanSpaceImports()).updatesPending).toBe(1)
  const settings = await b.api.getImportSettings()
  b.api.setImportSettings({ defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId: space.id, automatic: false, updates: 'automatic' }] })
  await b.api.scanSpaceImports(); expect(ref(b, bi)).toContain(result.contentVersion)
  expect(b.store.blocksOf(bi).note.data.text).toBe('B 笔记')
  expect((await a.api.restoreSpaceVersion(request)).replayed).toBe(true)
  await expect(a.api.restoreSpaceVersion({ ...request, contentVersion: result.contentVersion })).rejects.toThrow('REQUEST_ID_CONFLICT')
  await new SpaceLifecycle(space).execute(f.mutation('recycle'))
  expect((await a.api.spaceFileHistory({ spaceId: space.id, fileId })).canRestore).toBe(false)
  await expect(a.api.restoreSpaceVersion(f.history())).rejects.toThrow('VERSION_CONFLICT')
})

it('历史发布响应丢失后重开显式重试，只重放提交；不会重复增加版本', async () => {
  const f = await fixture(), input = f.history(), service = new SpaceHistory(f.space)
  const original = SpaceVersions.prototype.commit
  const spy = vi.spyOn(SpaceVersions.prototype, 'commit').mockImplementationOnce(async function(this: SpaceVersions, input, transfer) {
    await original.call(this, input, transfer); throw new Error('injected response loss')
  })
  await expect(service.restore(input)).rejects.toThrow('response loss'); spy.mockRestore()
  const reopened = new FileSpace(f.space.root)
  try {
    const recovered = await new SpaceHistory(reopened).restore(input)
    expect(recovered.replayed).toBe(true)
    expect(new SpaceVersions(reopened).versions(f.fileId)).toHaveLength(3)
  } finally { reopened.close() }
})

it('历史分页检测修订变化，读取权限不代表可恢复历史，历史请求不能借给其他写操作', async () => {
  const f = await fixture(), { a, b, space, fileId, versions } = f
  const first = await a.api.spaceFileHistory({ spaceId: space.id, fileId, limit: 1 })
  expect(first.total).toBe(2); expect(first.nextOffset).toBe(1)
  expect((await b.api.spaceFileHistory({ spaceId: space.id, fileId })).canRestore).toBe(false)
  await expect(b.api.restoreSpaceVersion(f.history())).rejects.toThrow('SPACE_REVISE_DENIED')
  const input = f.history(); await a.api.restoreSpaceVersion(input)
  expect(() => a.api.spaceFileHistory({ spaceId: space.id, fileId, offset: 1, revision: first.revision })).toThrow('SPACE_CHANGED')
  await expect(versions.mutateLifecycle({ ...f.mutation('recycle'), requestId: input.requestId })).rejects.toThrow('REQUEST_ID_CONFLICT')
})
