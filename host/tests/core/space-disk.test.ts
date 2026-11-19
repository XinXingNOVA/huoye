import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SpaceDisk } from '../../src/storage/space-disk'
import { SpaceHistory } from '../../src/storage/space-history'
import { LibraryFiles } from '../../src/storage/library-files'
import { sharedVersionFile, versionHost } from '../helpers/version-files'
import { SpaceDisposal } from '../../src/storage/space-disposal'
import { FileSpace } from '../../src/storage/file-space'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const fixture = async () => {
  const f = await sharedVersionFile(cleanups), disk = new SpaceDisk(f.versions.space)
  const versionId = f.versions.head(f.fileId), path = f.versions.read(f.fileId, versionId)
  return { ...f, disk, versionId, path }
}
const check = (f: Awaited<ReturnType<typeof fixture>>, deep = false) => f.disk.check({ spaceId: f.spaceId, requestId: randomUUID(), deep })
const request = async (f: Awaited<ReturnType<typeof fixture>>, source?: string) => {
  const input = { spaceId: f.spaceId, versionId: f.versionId, ...(source ? { source } : {}) }
  return { ...input, token: (await f.disk.preview(input)).token, requestId: randomUUID() }
}
it('检查不发布；确认后失败可跨重开接续，手动／自动接纳与旧版相同内容修复各自保持语义', async () => {
  const f = await fixture(), { a, b, ai, bi, disk, versions, fileId, spaceId, versionId, path, source } = f
  a.api.put(ai, 'note', { text: '保留 A 的笔记' }); b.api.put(bi, 'note', { text: '保留 B 的笔记' })
  const oldRef = String(a.store.blocksOf(ai).file.data.path)
  const policy = await b.api.getImportSettings()
  b.api.setImportSettings({ defaultSpaceId: policy.defaultSpaceId, collect: true, spaces: [{ spaceId, automatic: false, updates: 'automatic' }] })
  writeFileSync(path, '# externally changed')
  await check(f, true); await check(f)
  expect(disk.page({ spaceId }).items).toMatchObject([{ versionId, state: 'modified', current: true }])
  expect(versions.versions(fileId)).toHaveLength(1)
  expect(() => new LibraryFiles(a.lib.root).readable(oldRef)).toThrow('FILE_CHANGED')
  const input = await request(f)
  versions.space.db.exec(`CREATE TRIGGER fail_disk_receipt BEFORE UPDATE OF result ON space_disk_operations BEGIN SELECT RAISE(ABORT,'retry disk receipt'); END`)
  await expect(disk.apply(input)).rejects.toThrow('retry disk receipt')
  expect(versions.versions(fileId)).toHaveLength(2)
  versions.space.db.exec('DROP TRIGGER fail_disk_receipt')
  const reopened = new FileSpace(versions.space.root)
  try {
    const resumed = new SpaceDisk(reopened)
    expect(resumed.page({ spaceId }).pending).toHaveLength(1)
    await resumed.resume(spaceId, input.requestId)
    expect((await resumed.apply(input)).replayed).toBe(true)
    await expect(resumed.apply({ ...input, source })).rejects.toThrow('REQUEST_ID_CONFLICT')
  } finally { reopened.close() }
  expect(versions.versions(fileId)).toHaveLength(2)
  expect(disk.page({ spaceId }).items[0].replacement).toBe(versions.head(fileId))
  await a.api.refreshFileSpace(spaceId); await b.api.refreshFileSpace(spaceId)
  await b.scheduler.idle()
  expect(String(a.store.blocksOf(ai).file.data.path)).toBe(oldRef)
  expect(b.store.blocksOf(bi).body.data.content).toContain('externally changed')
  expect(b.store.blocksOf(bi).note.data.text).toBe('保留 B 的笔记')
  const preview = await a.api.previewFileUpdate(ai)
  expect(preview.previous.unavailable).toContain('FILE_CHANGED'); expect(preview.current.sample).toBe('# externally changed')
  expect(new SpaceHistory(versions.space).page({ spaceId, fileId }).versions.find(v => v.id === versionId)?.unavailable).toContain('FILE_CHANGED')
  // 找回旧版相同字节，原引用和历史可读；不会把当前空间版本退回。
  const repair = await disk.preview({ spaceId, versionId, source })
  expect(repair.action).toBe('repair')
  await disk.apply({ spaceId, versionId, source, token: repair.token, requestId: randomUUID() })
  expect(readFileSync(new LibraryFiles(a.lib.root).readable(oldRef), 'utf8')).toBe('# version-one')
  expect(versions.head(fileId)).toBe(preview.current.id)
  a.api.acceptFileUpdate({ id: ai, expectedPath: preview.expectedPath, revision: preview.revision, contentVersion: preview.current.id, requestId: randomUUID() })
  await a.scheduler.idle()
  expect(a.store.blocksOf(ai).note.data.text).toBe('保留 A 的笔记')
  expect(disk.page({ spaceId }).total).toBe(0)
})
it('缺失重新定位校验内容；拒绝过期预览，修复事务失败后重试不改身份或增加版本', async () => {
  const f = await fixture(), { disk, path, dir, versions, fileId, versionId, spaceId, a, ai } = f
  const moved = join(dir, '移动到这里.md'), wrong = join(dir, '错误文件.md')
  renameSync(path, moved); writeFileSync(wrong, 'not the same')
  const before = a.store.blocksOf(ai)
  await check(f)
  expect(disk.page({ spaceId }).items[0].state).toBe('missing')
  const no = await disk.preview({ spaceId, versionId, source: wrong }); expect(no.blocked).toContain('内容与原版本不符')
  await expect(disk.apply({ spaceId, versionId, source: wrong, token: no.token, requestId: randomUUID() })).rejects.toThrow('内容与原版本不符')
  const stale = await request(f, moved)
  writeFileSync(moved, 'changed after preview')
  await expect(disk.apply(stale)).rejects.toThrow('PREVIEW_CHANGED')
  writeFileSync(moved, '# version-one')
  const input = await request(f, moved)
  versions.space.db.exec("CREATE TRIGGER fail_repair BEFORE UPDATE OF result ON space_disk_operations BEGIN SELECT RAISE(ABORT,'retry repair'); END")
  await expect(disk.apply(input)).rejects.toThrow('retry repair')
  expect(() => versions.read(fileId, versionId)).toThrow()
  expect(disk.page({ spaceId }).pending).toHaveLength(1)
  versions.space.db.exec('DROP TRIGGER fail_repair'); await disk.apply(input)
  await a.api.refreshFileSpace(spaceId)
  expect(readFileSync(versions.read(fileId, versionId), 'utf8')).toBe('# version-one')
  expect(readFileSync(moved, 'utf8')).toBe('# version-one')
  expect(versions.versions(fileId)).toHaveLength(1); expect(a.store.blocksOf(ai)).toEqual(before)
  const trash = join(dir, 'fake-system-trash')
  const disposal = new SpaceDisposal(versions.space, { async trashDirectory(path) { renameSync(path, trash) } })
  const selection = { spaceId, action: 'trash' as const, files: [{ id: fileId, revision: versions.space.byId(fileId)!.revision }] }
  const preview = disposal.preview(selection)
  expect(preview.files[0].reason).toBeUndefined()
  expect((await disposal.execute({ ...selection, previewToken: preview.previewToken, requestId: randomUUID() })).items[0].outcome).toBe('done')
  const bundle = versions.space.db.prepare('SELECT bundle FROM space_disposals WHERE file_id=?').pluck().get(fileId) as string
  renameSync(trash, join(versions.space.root, bundle))
  const restore = { spaceId, action: 'verify' as const, files: [{ id: fileId, revision: versions.space.byId(fileId)!.revision }] }
  expect((await disposal.execute({ ...restore, previewToken: disposal.preview(restore).previewToken, requestId: randomUUID() })).items[0].outcome).toBe('done')
  expect(readFileSync(versions.read(fileId, versionId), 'utf8')).toBe('# version-one')
})
it('stat 变化但内容不变可继续读；相同大小与时间的篡改、符号链接和空间离线不会被当成正常内容', async () => {
  const f = await fixture(), { disk, versions, spaceId, versionId, path, source, fileId } = f
  const baseline = versions.version(fileId, versionId), stats = statSync(path)
  utimesSync(path, new Date(), new Date(Date.now() + 3000))
  await check(f)
  expect(disk.page({ spaceId }).total).toBe(0)
  expect(versions.read(fileId, versionId)).toBe(path); expect(versions.version(fileId, versionId)).toEqual(baseline)
  writeFileSync(path, '# version-two'); utimesSync(path, stats.atime, stats.mtime)
  await check(f, true)
  expect(disk.page({ spaceId }).items[0].state).toBe('modified')
  expect(() => versions.read(fileId, versionId)).toThrow('FILE_CHANGED')
  unlinkSync(path); symlinkSync(source, path)
  await check(f)
  expect(disk.page({ spaceId }).items[0].state).toBe('unreadable')
  const files = join(versions.space.root, 'files'); renameSync(files, files + '-offline')
  try { await expect(check(f)).rejects.toThrow(); expect(disk.page({ spaceId }).items[0].state).toBe('unreadable') }
  finally { renameSync(files + '-offline', files) }
})
it('取消保留已检查事实；未授权拒绝确认；未发布失败任务可放弃，重新打开不自行发布', async () => {
  const f = await fixture(), { disk, versions, spaceId, versionId, path, b } = f
  writeFileSync(path, '# external')
  const controller = new AbortController(); controller.abort()
  expect(await disk.check({ spaceId, requestId: randomUUID() }, controller.signal)).toMatchObject({ cancelled: true, checked: 0 })
  const denied = new SpaceDisk(versions.space, `library:${b.lib.id}:${b.lib.files.bindings!.binding(spaceId).token}`)
  const preview = await denied.preview({ spaceId, versionId }); expect(preview.blocked).toContain('DENIED')
  await expect(denied.apply({ spaceId, versionId, token: preview.token, requestId: randomUUID() })).rejects.toThrow('DENIED')
  const input = await request(f)
  versions.space.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON file_versions BEGIN SELECT RAISE(ABORT,'stop before publish'); END")
  await expect(disk.apply(input)).rejects.toThrow('stop before publish')
  versions.space.db.exec('DROP TRIGGER fail_publish')
  b.close(); const library = versionHost(cleanups, b.lib.root); await library.api.scanSpaceImports()
  expect(versions.head(f.fileId)).toBe(versionId)
  disk.abandon(spaceId, input.requestId)
  expect(disk.page({ spaceId }).pending).toHaveLength(0)
  expect((await disk.apply(input)).action).toBe('abandoned')
  expect(versions.head(f.fileId)).toBe(versionId)

})
