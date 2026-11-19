import { createLegacySpace } from '../helpers/legacy-file-space'
import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSpace } from '../../src/storage/file-space'
import { SpaceVersions, inspectVersionReadiness } from '../../src/storage/space-versions'
import { LibraryFiles } from '../../src/storage/library-files'
import { SpaceLifecycle } from '../../src/storage/space-lifecycle'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rm-versions-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const versions = SpaceVersions.create(join(root, 'space'), 'shared')
  cleanup.push(() => { if (versions.space.db.open) versions.space.close() })
  const source = (text: string, name = randomUUID() + '.md') => { const path = join(root, name); writeFileSync(path, text); return path }
  const stage = (path: string, target?: { fileId: string; revision: number }, requestId = randomUUID()) => versions.stage({ spaceId: versions.space.id, source: path, target, requestId })
  const commit = (id: string, requestId = randomUUID()) => versions.commit({ spaceId: versions.space.id, draftId: id, previewToken: versions.preview(id).previewToken, requestId })
  return { root, versions, source, stage, commit }
}

it('版本内容持久保存、身份不变，提交与变化／回执一致，重启后重放不再次发布', async () => {
  const s = setup(), first = await s.stage(s.source('V1')), initial = await s.commit(first.draft.id)
  const second = await s.stage(s.source('V2'), { fileId: initial.fileId, revision: initial.revision })
  const request = { spaceId: s.versions.space.id, draftId: second.draft.id, previewToken: s.versions.preview(second.draft.id).previewToken, requestId: randomUUID() }
  const latest = await s.versions.commit(request)
  expect(latest).toMatchObject({ fileId: initial.fileId, revision: 2, changeSeq: 2 })
  expect(readFileSync(s.versions.read(initial.fileId, initial.contentVersion), 'utf8')).toBe('V1')
  expect(readFileSync(s.versions.read(initial.fileId, latest.contentVersion), 'utf8')).toBe('V2')
  expect(s.versions.versions(initial.fileId).map(v => v.ordinal)).toEqual([2, 1])
  expect(s.versions.changes(1)).toHaveLength(1)
  expect(inspectVersionReadiness(s.versions.space).versionBytes).toBe(4)
  s.versions.space.close()
  const reopened = new FileSpace(join(s.root, 'space')); cleanup.push(() => reopened.close())
  const service = new SpaceVersions(reopened)
  expect(await service.commit(request)).toMatchObject({ ...latest, replayed: true })
  expect(service.changes()).toHaveLength(2)
})

it('并发编辑只允许一个基线提交，失败草稿保留；重新预览不会绕过过期基线', async () => {
  const s = setup(), first = await s.stage(s.source('base')), base = await s.commit(first.draft.id)
  const target = { fileId: base.fileId, revision: base.revision }
  const [a, b] = await Promise.all([s.stage(s.source('A'), target), s.stage(s.source('B'), target)])
  const requests = [a, b].map(v => ({ spaceId: s.versions.space.id, draftId: v.draft.id, previewToken: s.versions.preview(v.draft.id).previewToken, requestId: randomUUID() }))
  const results = await Promise.allSettled(requests.map(r => s.versions.commit(r)))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const failed = results.findIndex(r => r.status === 'rejected'), draft = [a, b][failed].draft
  expect(s.versions.getDraft(draft.id).state).toBe('ready')
  expect(() => s.versions.preview(draft.id)).toThrow('VERSION_CONFLICT')
  expect(s.versions.versions(base.fileId)).toHaveLength(2)
})

it('草稿与提交请求幂等且跨操作不混用；原来源消失后仍可重放准备回执', async () => {
  const s = setup(), path = s.source('ready'), request = { spaceId: s.versions.space.id, source: path, requestId: randomUUID() }
  const ready = await s.versions.stage(request); rmSync(path)
  expect(await s.versions.stage(request)).toMatchObject({ draft: ready.draft, replayed: true })
  await expect(s.versions.commit({ spaceId: request.spaceId, draftId: ready.draft.id, previewToken: s.versions.preview(ready.draft.id).previewToken, requestId: request.requestId })).rejects.toThrow('REQUEST_ID_CONFLICT')
  await expect(s.versions.stage({ ...request, source: s.source('different') })).rejects.toThrow('REQUEST_ID_CONFLICT')
  expect(() => s.versions.discard(ready.draft.id, request.requestId)).toThrow('REQUEST_ID_CONFLICT')
  const id = randomUUID(); expect(s.versions.discard(ready.draft.id, id).replayed).toBe(false)
  expect(s.versions.discard(ready.draft.id, id).replayed).toBe(true)
  expect(() => s.versions.preview(ready.draft.id)).toThrow('EDIT_NOT_READY')
})

it('取消和复制中断没有发布任何文件；失败可重试，来源变化拒绝同请求重试', async () => {
  const s = setup(), controller = new AbortController(), path = s.source('x'.repeat(200_000))
  const request = { spaceId: s.versions.space.id, source: path, requestId: randomUUID() }
  await expect(s.versions.stage(request, { signal: controller.signal, progress: () => controller.abort() })).rejects.toThrow()
  expect(s.versions.space.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(0)
  expect(s.versions.changes()).toEqual([])
  const ready = await s.versions.stage(request)
  expect(ready.draft.state).toBe('ready')
  const c = new AbortController(); c.abort()
  const next = { ...request, requestId: randomUUID() }
  await expect(s.versions.stage(next, { signal: c.signal })).rejects.toThrow()
  writeFileSync(path, 'changed')
  await expect(s.versions.stage(next)).rejects.toThrow('FILE_CHANGED')
})

it('进程退出后的复制记录可同请求接续，未提交字节不进入文件／版本列表', async () => {
  const s = setup(), request = { spaceId: s.versions.space.id, source: s.source('interrupted'), requestId: randomUUID() }
  const c = new AbortController(); c.abort()
  await expect(s.versions.stage(request, { signal: c.signal })).rejects.toThrow()
  s.versions.space.db.prepare("UPDATE version_drafts SET state='copying',pid=2147483647").run()
  const pending = s.versions.space.db.prepare('SELECT id FROM version_drafts').pluck().get() as string
  expect(() => s.versions.preview(pending)).toThrow('EDIT_NOT_READY')
  expect((await s.versions.stage(request)).draft.id).toBe(pending)
  const ready = s.versions.getDraft(pending)
  expect(s.versions.versions(ready.fileId)).toEqual([])
  expect(existsSync(s.versions.space.root)).toBe(true)
  await s.commit(pending)
  expect(s.versions.versions(ready.fileId)).toHaveLength(1)
})

it('草稿被篡改或用符号链接替换时拒绝发布，发布事务失败保留可重试草稿', async () => {
  const s = setup(), draft = await s.stage(s.source('safe'))
  const row = s.versions.space.db.prepare('SELECT path FROM version_drafts WHERE id=?').get(draft.draft.id) as { path: string }
  const path = join(s.versions.space.root, row.path), request = { spaceId: s.versions.space.id, draftId: draft.draft.id, previewToken: s.versions.preview(draft.draft.id).previewToken, requestId: randomUUID() }
  writeFileSync(path, 'evil')
  await expect(s.versions.commit(request)).rejects.toThrow('FILE_CHANGED')
  rmSync(path); symlinkSync(s.source('safe'), path)
  await expect(s.versions.commit(request)).rejects.toThrow('INVALID_FILE_REFERENCE')
  rmSync(path); writeFileSync(path, 'safe')
  s.versions.space.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON version_receipts WHEN NEW.requestId='simulate-commit-failure' BEGIN SELECT RAISE(ABORT,'simulated'); END")
  const retry = { ...request, requestId: 'simulate-commit-failure' }
  await expect(s.versions.commit(retry)).rejects.toThrow('simulated')
  expect(s.versions.getDraft(draft.draft.id).state).toBe('ready')
  expect(s.versions.changes()).toHaveLength(0)
  expect(s.versions.versions(draft.draft.fileId)).toHaveLength(0)
  s.versions.space.db.exec('DROP TRIGGER fail_receipt')
  expect((await s.versions.commit(retry)).revision).toBe(1)
})

it('拒绝旧空间且格式和字节不变；新版本空间禁止旧关联及写入', async () => {
  const s = setup(), legacyRoot = join(s.root, 'legacy'); createLegacySpace(legacyRoot, 'private')
  const before = readFileSync(join(legacyRoot, '.file-space.db'))
  expect(() => new FileSpace(legacyRoot)).toThrow('LEGACY_STORAGE_UNSUPPORTED')
  expect(readFileSync(join(legacyRoot, '.file-space.db'))).toEqual(before)
  expect(() => s.versions.space.connect(randomUUID(), s.root, randomUUID())).toThrow('VERSION_PROTOCOL_REQUIRED')
  const draft = await s.stage(s.source('protected')), result = await s.commit(draft.draft.id)
  const file = s.versions.space.byId(result.fileId)!, files = new LibraryFiles(s.versions.space.root)
  expect(() => files.write(file.path, 'unsafe')).toThrow('VERSION_PROTOCOL_REQUIRED')
  expect(() => new LibraryFiles(s.versions.space.root).write(file.path, 'unsafe')).toThrow('VERSION_PROTOCOL_REQUIRED')
  expect((s.versions.space as any).reserve).toBeUndefined()
  const lifecycle = new SpaceLifecycle(s.versions.space)
  expect(lifecycle.preview({ spaceId: s.versions.space.id, action: 'recycle', files: [{ id: file.id, revision: file.revision }] }).blocked).toBeUndefined()
  expect(readFileSync(s.versions.read(file.id, result.contentVersion), 'utf8')).toBe('protected')
})

it('复制和提交校验不持有写事务，可取消校验而保留草稿', async () => {
  const s = setup(), progress: number[] = []
  const ready = await s.versions.stage({ spaceId: s.versions.space.id, source: s.source('a'.repeat(150_000)), requestId: randomUUID() }, {
    progress(copied) { expect(s.versions.space.db.inTransaction).toBe(false); progress.push(copied) }
  })
  expect(progress.at(-1)).toBe(150_000)
  const controller = new AbortController(), request = { spaceId: s.versions.space.id, draftId: ready.draft.id, previewToken: s.versions.preview(ready.draft.id).previewToken, requestId: randomUUID() }
  await expect(s.versions.commit(request, { signal: controller.signal, progress() { expect(s.versions.space.db.inTransaction).toBe(false); controller.abort() } })).rejects.toThrow()
  expect(s.versions.getDraft(ready.draft.id).state).toBe('ready')
  expect(s.versions.changes()).toEqual([])
  expect((await s.versions.commit(request)).revision).toBe(1)
})

it('暂存位置校验失败也结束复制状态，修复位置后可用同请求重试', async () => {
  const s = setup(), request = { spaceId: s.versions.space.id, source: s.source('safe'), requestId: randomUUID() }
  const alias = join(s.versions.space.root, 'files', '.versions'); symlinkSync(s.root, alias)
  await expect(s.versions.stage(request)).rejects.toThrow('INVALID_FILE_REFERENCE')
  expect(s.versions.space.db.prepare('SELECT state FROM version_drafts').pluck().get()).toBe('failed')
  rmSync(alias)
  expect((await s.versions.stage(request)).draft.state).toBe('ready')
})
