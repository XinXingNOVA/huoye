import { parseSpaceReference } from '../../src/storage/space-reference'
import { afterEach, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveTextFile } from '../helpers/helpers'
import { versionHost, sharedVersionFile, prepareVersionEdit as prepare } from '../helpers/version-files'
import { SpaceVersions } from '../../src/storage/space-versions'
import { LibraryFiles } from '../../src/storage/library-files'
import { serveLibraryFile } from '../../src/main/lib-protocol'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })
const host = (root?: string) => versionHost(cleanups, root)
const fixture = () => sharedVersionFile(cleanups)
const ref = (h: ReturnType<typeof host>, id: string) => String(h.store.blocksOf(id).file.data.path)
const text = (h: ReturnType<typeof host>, id: string) => readFileSync(h.lib.files.readable(ref(h,id)), 'utf8')
it('两库采用明确版本；发布者接纳，另一库继续读取旧内容，预览后接纳保留身份及业务数据', async () => {
  const { a,b,ai,bi,source,versions,fileId } = await fixture()
  a.api.put(ai,'note',{text:'A 笔记'});b.api.put(bi,'note',{text:'B 笔记'})
  b.api.patch(bi,'file',{name:'自定义名字.md'})
  const old = ref(b,bi);expect(old).toContain('spaces/v2/')
  writeFileSync(source,'# version-two')
  const request = await prepare(a,ai,source), result = await a.api.commitFileEdit(request)
  expect(result.library.state).toBe('accepted');expect(versions.versions(fileId)).toHaveLength(2)
  expect(text(a,ai)).toBe('# version-two');expect(text(b,bi)).toBe('# version-one')
  expect(await (await serveLibraryFile(b.lib.root,new Request(`lib://library/${old}`))).text()).toBe('# version-one')
  expect(readFileSync(new LibraryFiles(b.lib.root).readable(old),'utf8')).toBe('# version-one')
  const scan = await b.api.scanSpaceImports();expect(scan.updatesPending).toBe(1)
  const p=await b.api.previewFileUpdate(bi);expect(p.previous.sample).toBe('# version-one');expect(p.current.sample).toBe('# version-two')
  expect((await b.api.listSpaceFiles({spaceId:p.spaceId})).items[0]).toMatchObject({adoptedVersion:p.previous.id,contentVersion:p.current.id})
  const accept={id:bi,expectedPath:p.expectedPath,contentVersion:p.current.id,revision:p.revision,requestId:randomUUID()}
  b.api.acceptFileUpdate(accept)
  expect(text(b,bi)).toBe('# version-two');expect(b.store.blocksOf(bi).note.data.text).toBe('B 笔记')
  expect(b.store.blocksOf(bi).file.data.name).toBe('自定义名字.md')
  expect((await b.api.acceptFileUpdate(accept)).replayed).toBe(true)
  expect((await a.api.commitFileEdit(request)).space.contentVersion).toBe(result.space.contentVersion)
  expect(versions.versions(fileId)).toHaveLength(2)
  await b.scheduler.idle();expect(b.store.blocksOf(bi).body.data.content).toContain('version-two')
  expect(b.api.fileStorageInfo(bi)).toMatchObject({contentOrdinal:2,currentOrdinal:2})
})
it('空间没有新事件时，接纳映射指向已有旧引用仍能发现待更新版本', async () => {
  const { a, b, ai, bi, fileId, spaceId, source } = await fixture()
  const other = b.store.createEntity()
  b.store.put(other, 'file', b.store.blocksOf(bi).file.data)
  writeFileSync(source, '# updated')
  await a.api.commitFileEdit(await prepare(a, ai, source))
  const preview = await b.api.previewFileUpdate(bi)
  await b.api.acceptFileUpdate({ id: bi, expectedPath: preview.expectedPath, contentVersion: preview.current.id,
    revision: preview.revision, requestId: randomUUID() })
  expect(await b.api.scanSpaceImports()).toMatchObject({ updatesPending: 0, errors: [] })
  b.lib.db.prepare('UPDATE space_adoptions SET entity_id=? WHERE space_id=? AND file_id=?').run(other, spaceId, fileId)
  expect(await b.api.scanSpaceImports()).toMatchObject({ updatesPending: 1, errors: [] })
  expect(text(b, bi)).toBe('# updated')
  expect(text(b, other)).toBe('# version-one')
})

it('自动更新独立于新文件收录；关闭仓库后多次发布，重开追赶，回收素材不复活', async () => {
  const {a,b,ai,bi,source,spaceId}=await fixture(), root=b.lib.root
  const settings=await b.api.getImportSettings()
  b.api.setImportSettings({defaultSpaceId:settings.defaultSpaceId,collect:true,spaces:[{spaceId,automatic:false,updates:'automatic'}]})
  b.api.put(bi,'note',{text:'保留笔记'});b.close()
  writeFileSync(source,'# version-two');await a.api.commitFileEdit(await prepare(a,ai,source))
  writeFileSync(source,'# version-three');await a.api.commitFileEdit(await prepare(a,ai,source))
  const reopened=host(root), scan=await reopened.api.scanSpaceImports()
  expect(scan.updated).toBe(1);expect(text(reopened,bi)).toBe('# version-three');expect(reopened.store.blocksOf(bi).note.data.text).toBe('保留笔记')
  reopened.api.trash([bi]);writeFileSync(source,'# version-four');await a.api.commitFileEdit(await prepare(a,ai,source))
  expect((await reopened.api.scanSpaceImports()).updatesPending).toBe(1);expect(reopened.store.isTrashed(bi)).toBe(true)
  reopened.api.restore([bi]);await reopened.api.scanSpaceImports();expect(text(reopened,bi)).toBe('# version-four')
})
it('旧写接口拒绝改版本字节，创建独立副本保留素材和原件，解除关联后历史不可旁路读取', async () => {
  const {a,b,ai,bi,versions,spaceId}=await fixture(), old=ref(a,ai)
  expect(()=>a.lib.files.write(old,'bad')).toThrow('VERSION_PROTOCOL_REQUIRED')
  await a.api.makeFileIndependent(ai)
  expect(ref(a,ai)).not.toBe(old);expect(text(a,ai)).toBe('# version-one')
  await saveTextFile(a,ai,'private copy');expect(text(b,bi)).toBe('# version-one')
  a.api.unlinkFileSpace(spaceId);expect(()=>a.lib.files.readable(old)).toThrow('SPACE_NOT_LINKED')
  a.api.linkFileSpace(versions.space.root);expect(readFileSync(a.lib.files.readable(old),'utf8')).toBe('# version-one')
  expect(()=>a.lib.files.readable(old.replace(/spaces\/v2\/(.*?)\/(.*?)\/(.*?)\//,'spaces/v1/$1/$2/'))).toThrow('LEGACY_STORAGE_UNSUPPORTED')
})

it('旧接纳预览不能接纳后来发布的版本', async () => {
  const {a,b,ai,bi,source}=await fixture()
  writeFileSync(source,'# version-two');await a.api.commitFileEdit(await prepare(a,ai,source))
  const p=await b.api.previewFileUpdate(bi)
  writeFileSync(source,'# version-three');await a.api.commitFileEdit(await prepare(a,ai,source))
  expect(()=>b.api.acceptFileUpdate({id:bi,expectedPath:p.expectedPath,contentVersion:p.current.id,revision:p.revision,requestId:randomUUID()})).toThrow('SPACE_CHANGED')
  expect(text(b,bi)).toBe('# version-one')
})

it('版本空间支持只保存与字节导入，失败重试不复制版本', async () => {
  const {a,source,versions,spaceId}=await fixture()
  const input={spaceId,collect:false,requestId:randomUUID()}, bytes=[{type:'bytes' as const,name:'bytes.md',bytes:Buffer.from('bytes-new-content')}]
  a.lib.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON operation_receipt WHEN NEW.request_id='"+input.requestId+"' BEGIN SELECT RAISE(ABORT,'simulate collect failure'); END")
  await expect(a.api.importToLibrary(bytes,input)).rejects.toThrow('simulate collect failure')
  const before=versions.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()
  a.lib.db.exec('DROP TRIGGER fail_receipt')
  const result=await a.api.importToLibrary(bytes,input)
  expect(result.items).toEqual([]);expect(result.saved).toHaveLength(1)
  expect(versions.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()).toBe(before)
  // API 幂等返回历史结果；原始外部来源不影响已接纳版本。
  writeFileSync(source,'external change');expect((await a.api.importToLibrary(bytes,input)).saved).toEqual(result.saved)

})
it('自动接纳单文件失败不会堵住后续文件；候选与游标原子落盘，保留失败重试', async () => {
  const {a,b,ai,bi,source,spaceId,dir}=await fixture()
  const extra=join(dir,'extra.md');writeFileSync(extra,'# extra-one')
  const saved=await a.api.importToLibrary([{type:'file',path:extra}],{spaceId,requestId:randomUUID()})
  const extraId=saved.items[0].id, page=await a.api.listSpaceFiles({spaceId}), f=page.items.find(f=>f.name==='extra.md')!
  const second=await b.api.adoptSpaceFiles({spaceId,files:[{id:f.id,revision:f.revision}],requestId:randomUUID()})
  const secondId=(second.result as {items:{id:string}[]}).items[0].id
  const settings=await b.api.getImportSettings()
  b.api.setImportSettings({defaultSpaceId:settings.defaultSpaceId,collect:true,spaces:[{spaceId,automatic:false,updates:'automatic'}]})
  writeFileSync(source,'# version-two');writeFileSync(extra,'# extra-two')
  await a.api.commitFileEdit(await prepare(a,ai,source));await a.api.commitFileEdit(await prepare(a,extraId,extra))
  b.lib.db.exec("CREATE TRIGGER fail_one BEFORE UPDATE ON block WHEN NEW.kind='file' AND NEW.entity_id='"+bi+"' BEGIN SELECT RAISE(ABORT,'one fails'); END")
  const scan=await b.api.scanSpaceImports()
  expect(scan.updated).toBe(1);expect(scan.updatesPending).toBe(1);expect(text(b,secondId)).toBe('# extra-two');expect(text(b,bi)).toBe('# version-one')
  expect(b.lib.db.prepare('SELECT seq FROM space_update_cursor WHERE space_id=?').pluck().get(spaceId)).toBeGreaterThan(0)
  b.lib.db.exec('DROP TRIGGER fail_one');expect((await b.api.scanSpaceImports()).updated).toBe(1)
  expect((await b.api.scanSpaceImports()).updatesPending).toBe(0)
})

it('成功批次释放导入令牌：同一路径以后内容改变可以再次导入，不复用旧发布请求', async () => {
  const {a,source,spaceId,versions}=await fixture()
  a.api.setDefaultFileSpace(spaceId)
  writeFileSync(source,'# second import');const first=await a.api.ingest([{type:'file',path:source}])
  writeFileSync(source,'# third import');const second=await a.api.ingest([{type:'file',path:source}])
  expect(second[0]).not.toBe(first[0]);expect(text(a,first[0])).toBe('# second import');expect(text(a,second[0])).toBe('# third import')
  expect(versions.space.db.prepare('SELECT count(*) FROM version_import_batches').pluck().get()).toBe(0)
})

it('退役发布只恢复已有回执：离线和接纳失败可重试，改过引用不覆盖，未发布意图不后台提交', async () => {
  const { a, ai, source, versions, spaceId, fileId } = await fixture()
  expect(a.lib.db.prepare("SELECT 1 FROM sqlite_master WHERE name='space_publications'").get()).toBeUndefined()
  for (const name of ['prepareFileReplacement', 'publishFileReplacement', 'discardFileReplacement', 'cancelFileReplacementPreparation']) expect(name in a.api).toBe(false)
  // 旧表直接作为冻结持久格式夹具构造，不恢复任何旧写入口。
  a.lib.db.exec('CREATE TABLE space_publications (request_id TEXT PRIMARY KEY, signature TEXT NOT NULL, input TEXT NOT NULL, result TEXT)')
  const owner = new SpaceVersions(versions.space, `library:${a.lib.id}:${a.lib.files.bindings!.binding(spaceId).token}`)
  async function legacyJob(id: string, publish: boolean) {
    const reference = ref(a, id), parsed = parseSpaceReference(reference)!
    const staged = await owner.stage({ spaceId, source, target: { fileId: parsed.fileId, revision: versions.space.byId(parsed.fileId)!.revision }, requestId: randomUUID() })
    const preview = owner.preview(staged.draft.id)
    const input = { spaceId, draftId: staged.draft.id, previewToken: preview.previewToken, requestId: randomUUID(), id, expectedPath: reference }
    a.lib.db.prepare('INSERT INTO space_publications VALUES (?,?,?,NULL)').run(input.requestId, createHash('sha256').update(JSON.stringify(input)).digest('hex'), JSON.stringify(input))
    if (publish) await owner.commit({ spaceId, draftId: input.draftId, previewToken: input.previewToken, requestId: input.requestId })
    return input
  }
  const other = join(versions.space.root, 'other.md'), last = join(versions.space.root, 'last.md')
  writeFileSync(other, '# other-one'); writeFileSync(last, '# last-one')
  const imported = await a.api.importToLibrary([{ type: 'file', path: other }, { type: 'file', path: last }], { spaceId, requestId: randomUUID() })
  const changed = imported.items[0].id, waiting = imported.items[1].id
  writeFileSync(source, '# legacy-published')
  const committed = await legacyJob(ai, true), superseded = await legacyJob(changed, true), uncommitted = await legacyJob(waiting, false)
  await a.api.makeFileIndependent(changed)
  const userChoice = ref(a, changed), oldWaiting = ref(a, waiting), count = versions.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()
  a.api.unlinkFileSpace(spaceId); await a.api.scanSpaceImports()
  expect(text(a, changed)).toBe('# other-one')
  a.api.linkFileSpace(versions.space.root)
  a.lib.db.exec("CREATE TRIGGER deny_legacy BEFORE UPDATE ON block WHEN NEW.kind='file' BEGIN SELECT RAISE(ABORT,'retry legacy adoption'); END")
  await a.api.scanSpaceImports()
  expect(a.lib.db.prepare('SELECT result FROM space_publications WHERE request_id=?').pluck().get(committed.requestId)).toBeNull()
  a.lib.db.exec('DROP TRIGGER deny_legacy'); const root = a.lib.root; a.close()
  const reopened = host(root); await reopened.api.scanSpaceImports(); await reopened.api.scanSpaceImports()
  expect(text(reopened, ai)).toBe('# legacy-published')
  expect(ref(reopened, changed)).toBe(userChoice)
  expect(ref(reopened, waiting)).toBe(oldWaiting)
  const result = (id: string) => reopened.lib.db.prepare('SELECT result FROM space_publications WHERE request_id=?').pluck().get(id) as string | null
  expect(JSON.parse(result(committed.requestId)!).library.state).toBe('accepted')
  expect(JSON.parse(result(superseded.requestId)!).library.state).toBe('skipped')
  expect(result(uncommitted.requestId)).toBeNull()
  expect(versions.space.db.prepare('SELECT count(*) FROM file_versions').pluck().get()).toBe(count)
  expect(versions.versions(fileId)).toHaveLength(2)
})

it.each(['current', 'legacy'] as const)('自动接纳后撤销改名，按新的文件块状态重新接纳；%s 回执保持可重放', async receiptKind => {
  const { a, b, ai, bi, source, spaceId, versions, fileId } = await fixture()
  const settings = await b.api.getImportSettings()
  b.api.setImportSettings({ defaultSpaceId: settings.defaultSpaceId, collect: true, spaces: [{ spaceId, automatic: false, updates: 'automatic' }] })
  b.api.run('file', 'rename', { names: { [bi]: 'display.md' } })
  writeFileSync(source, '# version-two'); await a.api.commitFileEdit(await prepare(a, ai, source))
  const preview = await b.api.previewFileUpdate(bi)
  let first = { id: bi, expectedPath: preview.expectedPath, contentVersion: preview.current.id, revision: preview.revision,
    requestId: `auto-version-${createHash('sha256').update(JSON.stringify([bi, preview.expectedPath, preview.current.id])).digest('hex')}` }
  if (receiptKind === 'legacy') b.api.acceptFileUpdate(first)
  else {
    expect(await b.api.scanSpaceImports()).toMatchObject({ updated: 1, updatesPending: 0 })
    first = { ...first, requestId: String(b.lib.db.prepare("SELECT request_id FROM operation_receipt WHERE request_id LIKE 'auto-version-%'").pluck().get()) }
  }
  await b.scheduler.idle(); expect(text(b, bi)).toBe('# version-two')
  const receipt = b.lib.db.prepare('SELECT * FROM operation_receipt WHERE request_id=?').get(first.requestId)
  b.api.undo(); await b.scheduler.idle()
  expect(text(b, bi)).toBe('# version-one')
  const before = b.store.blocksOf(bi), seq = before.file.seq
  b.lib.db.exec("CREATE TRIGGER fail_adoption BEFORE INSERT ON operation_receipt WHEN NEW.request_id LIKE 'auto-version-%' BEGIN SELECT RAISE(ABORT,'retry adoption'); END")
  expect(await b.api.scanSpaceImports()).toMatchObject({ updated: 0, updatesPending: 1 })
  expect(b.store.blocksOf(bi)).toEqual(before)
  b.lib.db.exec('DROP TRIGGER fail_adoption'); const root = b.lib.root; b.close()
  const reopened = host(root)
  expect(reopened.store.blocksOf(bi).file.seq).toBe(seq)
  expect(await reopened.api.scanSpaceImports()).toMatchObject({ updated: 1, updatesPending: 0 })
  expect(text(reopened, bi)).toBe('# version-two')
  expect(reopened.store.blocksOf(bi).file.data.name).toBe('document.md')
  expect(reopened.lib.db.prepare('SELECT * FROM operation_receipt WHERE request_id=?').get(first.requestId)).toEqual(receipt)
  const accepted = reopened.store.blocksOf(bi).file
  expect(reopened.api.acceptFileUpdate(first)).toMatchObject({ replayed: true })
  expect(reopened.store.blocksOf(bi).file).toEqual(accepted)
  expect(await reopened.api.scanSpaceImports()).toMatchObject({ updated: 0, updatesPending: 0 })
  expect(versions.versions(fileId)).toHaveLength(2)
})
