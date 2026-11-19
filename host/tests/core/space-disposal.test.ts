import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { openHost } from '../helpers/helpers'
import { SpaceVersions } from '../../src/storage/space-versions'
import { SpaceDisposal, type DisposalPlatform } from '../../src/storage/space-disposal'
import { SpaceLifecycle } from '../../src/storage/space-lifecycle'
import type { DisposalAction } from '../../src/shared/space-disposal'

const cleanups: (() => void)[] = []
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn() })
async function fixture() {
  const h = openHost(); cleanups.push(h.cleanup)
  const { host, root } = h
  const source = join(root, 'sample.md'); writeFileSync(source, '# version one')
  const [id] = await host.api.ingest([{ type: 'file', path: source }]); await host.scheduler.idle()
  host.api.put(id, 'note', { text: '保留笔记' })
  const binding = host.lib.files.bindings!.default(), space = binding.space, versions = new SpaceVersions(space)
  const file = space.db.prepare('SELECT id FROM files').get() as { id: string }
  const first = versions.head(file.id)
  writeFileSync(source, '# version two')
  const prepared = await versions.stage({ spaceId: space.id, source, target: { fileId: file.id, revision: 1 }, requestId: randomUUID() })
  const p = versions.preview(prepared.draft.id)
  await versions.commit({ spaceId: space.id, draftId: p.draft.id, previewToken: p.previewToken, requestId: randomUUID() })
  const fakeTrash = join(root, 'fake-system-trash'); mkdirSync(fakeTrash)
  let calls = 0
  const platform: DisposalPlatform = { async trashDirectory(path) { calls++; renameSync(path, join(fakeTrash, basename(path))) } }
  const service = new SpaceDisposal(space, platform), page = new SpaceLifecycle(space)
  const selection = (action: DisposalAction) => ({ spaceId: space.id, action, files: [{ id: file.id, revision: space.byId(file.id)!.revision }] })
  const input = (action: DisposalAction) => { const s = selection(action), preview = service.preview(s); return { ...s, previewToken: preview.previewToken, requestId: randomUUID() } }
  const job = () => space.db.prepare('SELECT d.* FROM space_disposals d JOIN space_file_records r ON d.id=r.disposal_id WHERE r.file_id=?').get(file.id) as { id: string; bundle: string; manifest: string; stage: string }
  const restore = () => renameSync(join(fakeTrash, basename(job().bundle)), join(space.root, job().bundle))
  return { host, root, id, fileId: file.id, space, versions, first, service, platform, page, selection, input, job, restore, calls: () => calls }
}
it('物理处置包含所有版本，保留仓库数据与空间身份；回执重放不重复移动', async () => {
  const f = await fixture(), original = f.versions.read(f.fileId, f.first), request = f.input('trash')
  expect(f.service.preview(f.selection('trash')).files[0].versions).toBe(2)
  expect((await f.service.execute(request)).items[0].outcome).toBe('done')
  expect(existsSync(original)).toBe(false)
  expect(f.space.byId(f.fileId)?.state).toBe('disposed')
  expect(f.host.store.blocksOf(f.id).note.data.text).toBe('保留笔记')
  expect(f.host.store.isTrashed(f.id)).toBe(false)
  expect(f.page.page({ spaceId: f.space.id }).total).toBe(0)
  expect(f.page.page({ spaceId: f.space.id, scope: 'records' }).items[0].lifecycle).toBe('disposed')
  expect(() => f.versions.read(f.fileId, f.first)).toThrow('FILE_UNAVAILABLE')
  expect((await f.service.execute(request)).replayed).toBe(true); expect(f.calls()).toBe(1)
  await expect(f.service.execute({ ...request, action: 'clean' })).rejects.toThrow('REQUEST_ID_CONFLICT')
})
it('归档只改变记录呈现，取消归档恢复列表，不改变内容读取和仓库素材', async () => {
  const f = await fixture()
  await f.service.execute(f.input('archive'))
  expect(f.page.page({ spaceId: f.space.id }).total).toBe(0)
  expect(readFileSync(f.versions.read(f.fileId, f.first), 'utf8')).toBe('# version one')
  expect(f.page.page({ spaceId: f.space.id, scope: 'records', recordScope: 'archived' }).items[0].archivedAt).toBeTruthy()
  await f.service.execute(f.input('unarchive'))
  expect(f.page.page({ spaceId: f.space.id }).total).toBe(1)
})
it('系统拒绝后保留内容和明确错误，重新预览可继续；核验还原恢复所有版本且不复活仓库素材', async () => {
  const f = await fixture(), platform = f.platform.trashDirectory
  f.platform.trashDirectory = async () => { throw new Error('system denied') }
  const result = await f.service.execute(f.input('trash'))
  expect(result.items[0].message).toContain('system denied')
  expect(f.space.byId(f.fileId)!.state).toBe('disposing')
  expect(existsSync(join(f.space.root, f.job().bundle, 'versions'))).toBe(true)
  f.platform.trashDirectory = platform
  expect((await f.service.execute(f.input('trash'))).items[0].outcome).toBe('done')
  f.host.api.trash([f.id]); f.restore()
  const verified = await f.service.execute(f.input('verify'))
  expect(verified.items[0]).toMatchObject({ outcome: 'done' })
  expect(readFileSync(f.versions.read(f.fileId, f.first), 'utf8')).toBe('# version one')
  expect(f.versions.versions(f.fileId)).toHaveLength(2)
  expect(f.host.store.isTrashed(f.id)).toBe(true)
})
it('还原内容损坏或目标冲突不覆盖、不开放读取', async () => {
  const f = await fixture(); await f.service.execute(f.input('trash')); f.restore()
  const manifest = JSON.parse(f.job().manifest), oldPath = manifest.versions[0].path.split('/').slice(3).join('/')
  writeFileSync(join(f.space.root, f.job().bundle, 'versions', oldPath), 'corrupt')
  expect((await f.service.execute(f.input('verify'))).items[0].outcome).toBe('failed')
  expect(f.space.byId(f.fileId)!.state).toBe('disposed')
  const source = join(f.space.root, 'files/.versions', f.fileId)
  mkdirSync(source); writeFileSync(join(source, 'keep.txt'), 'do not overwrite')
  expect((await f.service.execute(f.input('verify'))).items[0].message).toContain('RECOVERY_CONFLICT')
  expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('do not overwrite')
})
it('明细清理只允许已确认物理处置，保留最小标识、业务数据和回执，不能再恢复旧身份', async () => {
  const f = await fixture()
  expect(f.service.preview(f.selection('clean')).files[0].reason).toBeTruthy()
  await f.service.execute(f.input('trash'))
  const request = f.input('clean')
  expect((await f.service.execute(request)).items[0].outcome).toBe('done')
  expect(f.versions.versions(f.fileId)).toHaveLength(0)
  expect(f.space.byId(f.fileId)?.state).toBe('disposed')
  expect(f.host.store.blocksOf(f.id).note.data.text).toBe('保留笔记')
  expect(f.service.preview(f.selection('verify')).files[0].reason).toContain('已清理')
  expect(f.page.page({ spaceId: f.space.id, scope: 'records' }).total).toBe(0)
  expect(f.page.page({ spaceId: f.space.id, scope: 'records', recordScope: 'archived' }).items[0].cleanedAt).toBeTruthy()
  expect((await f.service.execute(request)).replayed).toBe(true)
})
it('已还原的文件包禁止清理记录；过期预览拒绝执行', async () => {
  const f = await fixture(), stale = f.input('trash')
  await f.service.execute(f.input('archive'))
  await expect(f.service.execute(stale)).rejects.toThrow('PREVIEW_CHANGED')
  await f.service.execute(f.input('trash')); f.restore()
  expect(f.service.preview(f.selection('clean')).files[0].reason).toContain('还原')
})
it('空间文件有未知内容或符号链接时拒绝整包物理处置', async () => {
  const f = await fixture(), directory = join(f.space.root, 'files/.versions', f.fileId)
  symlinkSync(f.root, join(directory, 'outside'))
  expect(f.service.preview(f.selection('trash')).files[0].reason).toContain('UNSAFE_PATH')
  expect(f.calls()).toBe(0)
})
it('处理中拒绝发布及逻辑回收，并发调用不能重复送系统废纸篓', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), platform = f.platform.trashDirectory
  f.platform.trashDirectory = async path => { await gate; await platform(path) }
  const input = f.input('trash'), task = f.service.execute(input)
  for (let n = 0; n < 100 && f.job()?.stage !== 'calling'; n++) await new Promise(r => setTimeout(r, 2))
  await expect(f.service.execute(input)).rejects.toThrow('DISPOSAL_BUSY')
  expect(new SpaceVersions(f.space).previewLifecycle({ ...f.selection('trash'), action: 'recycle' }).files[0].eligible).toBe(false)
  await expect(f.versions.stage({ spaceId: f.space.id, source: join(f.root, 'sample.md'), requestId: randomUUID(), target: { fileId: f.fileId, revision: f.space.byId(f.fileId)!.revision } })).rejects.toThrow('DISPOSAL_BUSY')
  release(); await task
})
it('系统响应与批次回执之间中断后，显式接续只补记结果，不重复处置', async () => {
  const f = await fixture(), input = f.input('trash'); await f.service.execute(input)
  f.space.db.prepare("UPDATE space_disposal_commands SET finished=0,pid=0,items='[]' WHERE request_id=?").run(input.requestId)
  f.space.db.prepare('UPDATE space_file_records SET busy_request=? WHERE file_id=?').run(input.requestId, f.fileId)
  expect(f.service.pending(f.space.id)[0]).toMatchObject({ running: false, completed: 0 })
  expect((await f.service.resume(f.space.id, input.requestId)).items[0].outcome).toBe('done')
  expect(f.calls()).toBe(1)
})
it('系统调用结果丢失时不把文件缺失当成功，还原后仍可核验', async () => {
  const f = await fixture(), platform = f.platform.trashDirectory
  f.platform.trashDirectory = async path => { await platform(path); throw new Error('response lost') }
  expect((await f.service.execute(f.input('trash'))).items[0].outcome).toBe('failed')
  expect(f.space.byId(f.fileId)!.state).toBe('disposing')
  expect(f.service.preview(f.selection('trash')).files[0].reason).toContain('待核对')
  f.restore()
  expect((await f.service.execute(f.input('verify'))).items[0].outcome).toBe('done')
  expect(f.calls()).toBe(1)
})
it('恢复内容已移回但数据库未提交时，核验重试接续，不覆盖或新增身份', async () => {
  const f = await fixture()
  await f.service.execute(f.input('trash')); f.restore()
  renameSync(join(f.space.root, f.job().bundle, 'versions'), join(f.space.root, 'files/.versions', f.fileId))
  expect((await f.service.execute(f.input('verify'))).items[0].outcome).toBe('done')
  expect(readFileSync(f.versions.read(f.fileId, f.first), 'utf8')).toBe('# version one')
})
it('批量系统处置逐项报告部分失败，重放不重复已完成项', async () => {
  const f = await fixture(), source = join(f.root, 'other.md')
  writeFileSync(source, 'another file')
  const p = await f.versions.stage({ spaceId: f.space.id, source, requestId: randomUUID() })
  const preview = f.versions.preview(p.draft.id)
  const second = await f.versions.commit({ spaceId: f.space.id, draftId: p.draft.id, previewToken: preview.previewToken, requestId: randomUUID() })
  let count = 0
  const original = f.platform.trashDirectory
  f.platform.trashDirectory = async path => { if (++count === 2) throw new Error('second failed'); await original(path) }
  const selection = { spaceId: f.space.id, action: 'trash' as const, files: [f.fileId, second.fileId].map(id => ({ id, revision: f.space.byId(id)!.revision })) }
  const input = { ...selection, previewToken: f.service.preview(selection).previewToken, requestId: randomUUID() }
  expect((await f.service.execute(input)).items.map(i => i.outcome)).toEqual(['done', 'failed'])
  expect(f.space.byId(second.fileId)!.state).toBe('disposing')
  expect((await f.service.execute(input)).replayed).toBe(true)
  expect(count).toBe(2)
  expect(f.service.pending(f.space.id)).toEqual([])
})
