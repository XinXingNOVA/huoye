import { SpaceQueries } from '../../src/core/space-queries'
import { SpaceLifecycle } from '../../src/storage/space-lifecycle'
import { SpaceVersions, setVersionPermission } from '../../src/storage/space-versions'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSpace } from '../../src/storage/file-space'
import { FileImport } from '../../src/storage/library-files'
import { openHost } from '../helpers/helpers'
import { randomUUID } from 'node:crypto'
import { parseSpaceReference } from '../../src/storage/space-reference'
import { serveLibraryFile } from '../../src/main/lib-protocol'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })
function setup() { const h = openHost(); cleanups.push(h.cleanup); return h }
function space(mode: 'shared' | 'private' = 'shared') {
  const dir = mkdtempSync(join(tmpdir(), 'rm-spaces-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'space'); return { ...FileSpace.create(root, mode), dir }
}
async function add(root: string, name = 'test.md', text = '# shared') {
  const source = join(root, name); writeFileSync(source, text)
  const storage = new FileSpace(root), staging = new FileImport(storage, randomUUID())
  try { const file = await staging.stage('source', source, name); return storage.byId(parseSpaceReference(file.reference)!.fileId)! }
  finally { staging.dispose(); storage.close() }
}
const embeddedSpace = (h: ReturnType<typeof setup>) => { const b = h.host.lib.files.bindings!; return b.open(b.rows().find(r => r.embedded)!.id) }
const page = (h: ReturnType<typeof setup>, id: string) => h.host.api.listSpaceFiles({ spaceId: id })
function adopt(h: ReturnType<typeof setup>, sid: string, id: string, revision: number, key = 'adoption-request-1') {
  return h.host.api.adoptSpaceFiles({ spaceId: sid, requestId: key, files: [{ id, revision }] })
}
it('文件详情按所属空间显示模式；与引用路径格式、默认写入目标无关', async () => {
  const h = setup(), s = space('private'), source = join(s.dir, 'info.md'); writeFileSync(source, '# storage info')
  const storageRoot = realpathSync(s.root)
  const [local] = await h.host.api.ingest([{ type: 'file', path: source }]); await h.host.scheduler.idle()
  const embedded = embeddedSpace(h)
  expect(await h.host.api.fileStorageInfo(local)).toMatchObject({ storageKind: 'space', spaceId: embedded.id,
    spaceName: embedded.info().name, spaceEmbedded: true, mode: 'private', shared: false, state: 'available' })
  h.host.api.linkFileSpace(s.root); h.host.api.setDefaultFileSpace(s.id)
  const [external] = await h.host.api.ingest([{ type: 'file', path: source }]); await h.host.scheduler.idle()
  h.host.api.setDefaultFileSpace(embedded.id)
  expect(await h.host.api.fileStorageInfo(external)).toMatchObject({ storageKind: 'space', spaceId: s.id,
    spaceName: s.name, spaceEmbedded: false, mode: 'private', shared: false, state: 'available' })
  // 两种位置都能升为共享，不能依据目录位置判断独享／共享。
  embedded.changeMode('shared', embedded.info().revision)
  const storage = new FileSpace(s.root)
  try { storage.changeMode('shared', storage.info().revision) } finally { storage.close() }
  expect(await h.host.api.fileStorageInfo(local)).toMatchObject({ spaceId: embedded.id, mode: 'shared', shared: true })
  expect(await h.host.api.fileStorageInfo(external)).toMatchObject({ spaceId: s.id, mode: 'shared', shared: true })
  h.host.api.unlinkFileSpace(s.id)
  const detached = await h.host.api.fileStorageInfo(external)
  expect(detached).toMatchObject({ storageKind: 'space', spaceId: s.id, storageRoot, associationState: 'detached', state: 'unavailable' })
  expect(detached.mode).toBeUndefined() // 不把上次模式当成当前事实。
  h.host.api.linkFileSpace(s.root)
  expect((await h.host.api.fileStorageInfo(external)).state).toBe('available')
  const moved = join(s.dir, 'moved'); renameSync(s.root, moved)
  const offline = await h.host.api.fileStorageInfo(external)
  expect(offline).toMatchObject({ spaceId: s.id, storageRoot, state: 'unavailable' })
  expect(offline.mode).toBeUndefined()
  h.host.api.linkFileSpace(moved)
  const linked = await h.host.api.fileStorageInfo(external)
  expect(linked).toMatchObject({ spaceName: s.name, storageRoot: realpathSync(moved), mode: 'shared', state: 'available' })
  rmSync(linked.path!)
  expect(await h.host.api.fileStorageInfo(external)).toMatchObject({ spaceId: s.id, mode: 'shared', state: 'missing' })
})

it('两个仓库先关联共享空间，再选择收录；各有业务身份与笔记，原件不复制', async () => {
  const s = space(), file = await add(s.root), a = setup(), b = setup()
  a.host.api.linkFileSpace(s.root); b.host.api.linkFileSpace(s.root)
  expect((await a.host.api.query({})).ids).toEqual([])
  expect((await page(a,s.id)).items[0].collected).toBeUndefined()
  const aa = await adopt(a,s.id,file.id,file.revision), bb = await adopt(b,s.id,file.id,file.revision)
  const ai = (aa.result as any).items[0].id, bi = (bb.result as any).items[0].id
  expect(ai).not.toBe(bi)
  a.host.api.put(ai, 'note', { text: 'A 笔记' })
  expect(b.host.store.blocksOf(bi).note).toBeUndefined()
  const path = String(a.host.store.blocksOf(ai).file.data.path)
  expect(path).toBe(b.host.store.blocksOf(bi).file.data.path)
  expect(readFileSync(a.host.lib.files.readable(path), 'utf8')).toBe('# shared')
  const response = await serveLibraryFile(a.root, new Request(`lib://library/${path}`))
  expect(await response.text()).toBe('# shared')
  a.host.close()
  expect(readFileSync(b.host.lib.files.readable(path), 'utf8')).toBe('# shared')
})
it('独享空间拒绝第二个仓库；显式共享后允许，多关联时不能降级', () => {
  const s=space('private'), a=setup(), b=setup()
  expect(() => a.host.api.linkFileSpace(s.root, randomUUID())).toThrow('FILE_SPACE_IDENTITY')
  expect(a.host.lib.files.bindings!.rows().some(r => r.id === s.id)).toBe(false)
  a.host.api.linkFileSpace(s.root, s.id)
  const before = b.host.lib.files.bindings!.rows()
  expect(() => b.host.api.linkFileSpace(s.root)).toThrow('SPACE_PRIVATE')
  expect(b.host.lib.files.bindings!.rows()).toEqual(before)
  const storage = new FileSpace(s.root)
  try {
    storage.changeMode('shared',storage.info().revision);b.host.api.linkFileSpace(s.root)
    expect(() => storage.changeMode('private',storage.info().revision)).toThrow('多个仓库')
    b.host.api.unlinkFileSpace(s.id);storage.changeMode('private',storage.info().revision)
    expect(storage.info().mode).toBe('private')
    const detached = b.host.lib.files.bindings!.binding(s.id)
    expect(() => b.host.api.linkFileSpace(s.root)).toThrow('SPACE_PRIVATE')
    expect(b.host.lib.files.bindings!.binding(s.id)).toEqual(detached)
    expect(storage.info().members).toBe(1)
  } finally { storage.close() }
})
it('候选修订失配拒绝；收录可撤销，同请求重放不复活，重新收录恢复原身份', async () => {
  const s=space(),file=await add(s.root),h=setup();h.host.api.linkFileSpace(s.root)
  expect(() => adopt(h,s.id,file.id,999)).toThrow('SPACE_CHANGED')
  const result=await adopt(h,s.id,file.id,file.revision),id=(result.result as any).items[0].id
  h.host.api.undo();expect(h.host.store.isTrashed(id)).toBe(true)
  expect((await adopt(h,s.id,file.id,file.revision)).replayed).toBe(true)
  expect(h.host.store.isTrashed(id)).toBe(true)
  expect(((await adopt(h,s.id,file.id,file.revision,'adoption-request-2')).result as any).items[0].id).toBe(id)
  expect(h.host.store.isTrashed(id)).toBe(false)
})
it('独享空间的显示改名、撤销及重启接续', async () => {
  const s=space('private'),h=setup();h.host.api.linkFileSpace(s.root);h.host.api.setDefaultFileSpace(s.id)
  const source=join(s.dir,'source.md');writeFileSync(source,'# original')
  const [id]=await h.host.api.ingest([{type:'file',path:source}]);await h.host.scheduler.idle()
  const before=h.host.store.blocksOf(id).file.data
  expect(String(before.path)).toContain(`spaces/v2/${s.id}/`)
  h.host.api.run('file','rename',{names:{[id]:'renamed'}})
  h.host.api.undo()
  expect(h.host.store.blocksOf(id).file.data).toEqual(before)
  expect(readFileSync(h.host.lib.files.readable(String(before.path)),'utf8')).toBe('# original')
  h.host.close();const next=openHost(undefined,undefined,h.root);cleanups.push(() => next.host.close())
  expect(readFileSync(next.host.lib.files.readable(String(before.path)),'utf8')).toBe('# original')
})
it('共享空间解除关联后原件仍在，已有引用离线', async () => {
  const s=space(),file=await add(s.root),h=setup();h.host.api.linkFileSpace(s.root)
  const id=((await adopt(h,s.id,file.id,file.revision)).result as any).items[0].id, before=h.host.store.blocksOf(id).file.data
  expect(readFileSync(join(s.root,file.path),'utf8')).toBe('# shared')
  h.host.api.unlinkFileSpace(s.id)
  expect(() => h.host.lib.files.readable(String(before.path))).toThrow('关联')
  expect(readFileSync(join(s.root,file.path),'utf8')).toBe('# shared')
  h.host.api.linkFileSpace(s.root);expect(h.host.lib.files.readable(String(before.path))).toBe(realpathSync(join(s.root,file.path)))
})
it('未关联空间不可读；离线默认不回退，空间移动可显式重新关联', async () => {
  const s=space(),file=await add(s.root),h=setup()
  expect(() => page(h,s.id)).toThrow('SPACE_NOT_LINKED')
  h.host.api.linkFileSpace(s.root);h.host.api.setDefaultFileSpace(s.id)
  const root=join(s.dir,'moved');renameSync(s.root,root)
  const source=join(s.dir,'new.md');writeFileSync(source,'new')
  await expect(h.host.api.ingest([{type:'file',path:source}])).rejects.toThrow('FILE_SPACE_OFFLINE')
  h.host.api.linkFileSpace(root)
  expect((await page(h,s.id)).items[0].id).toBe(file.id)
})
it('默认导入按空间去重，收录映射不会重复建素材；相同内容的不同文件身份独立', async () => {
  const s=space(), h=setup(), source=join(s.dir,'same.txt');writeFileSync(source,'same')
  const [local]=await h.host.api.ingest([{type:'file',path:source}])
  h.host.api.linkFileSpace(s.root);h.host.api.setDefaultFileSpace(s.id)
  const [external]=await h.host.api.ingest([{type:'file',path:source}])
  expect(external).not.toBe(local)
  expect(await h.host.api.ingest([{type:'file',path:source}])).toEqual([external])
  let files=(await page(h,s.id)).items;expect(files).toHaveLength(1);expect(files[0].collected).toBe(external)
  expect((await adopt(h,s.id,files[0].id,files[0].revision)).result).toMatchObject({items:[{id:external,outcome:'existing'}]})
  const other=await add(s.root,'same-copy.txt','same')
  const result=await adopt(h,s.id,other.id,other.revision,'new-file-identity')
  expect((result.result as any).items[0].id).not.toBe(external)
})
it('双端登记中断可以重试，解除中断明确保留状态；错误身份和相同身份副本不能顶替关联', async () => {
  const s=space(),h=setup();h.host.api.linkFileSpace(s.root)
  h.host.lib.db.prepare("UPDATE file_spaces SET state='pending' WHERE id=?").run(s.id)
  expect(() => page(h,s.id)).toThrow('SPACE_NOT_LINKED')
  h.host.api.linkFileSpace(s.root);expect((await page(h,s.id)).items).toEqual([])
  h.host.lib.db.prepare("UPDATE file_spaces SET state='detaching' WHERE id=?").run(s.id)
  expect(() => h.host.api.linkFileSpace(s.root)).toThrow('上次解除')
  h.host.api.unlinkFileSpace(s.id);h.host.api.linkFileSpace(s.root)
  const other=space();h.host.lib.db.prepare('UPDATE file_spaces SET root=? WHERE id=?').run(other.root,s.id)
  h.host.close();const next=openHost(undefined,undefined,h.root);cleanups.push(() => next.host.close())
  expect(() => next.host.api.listSpaceFiles({spaceId:s.id})).toThrow('FILE_SPACE_IDENTITY')
})
it('候选收录附加失败整批回滚且不留映射或回执，原件可继续选择', async () => {
  const s=space(),file=await add(s.root),h=setup();h.host.api.linkFileSpace(s.root)
  const input={spaceId:s.id,requestId:'bad-metadata-adopt',files:[{id:file.id,revision:file.revision,metadata:{'missing.apply':{}}}]}
  expect(() => h.host.api.adoptSpaceFiles(input)).toThrow()
  expect((await page(h,s.id)).items[0].collected).toBeUndefined()
  expect(h.host.lib.db.prepare('SELECT count(*) FROM operation_receipt WHERE request_id=?').pluck().get(input.requestId)).toBe(0)
  expect(readFileSync(join(s.root,file.path),'utf8')).toBe('# shared')
})
it('仓库副本不能复用外部空间的独享关联；原仓库移动后可显式重连', async () => {
  const s=space('private'),h=setup();h.host.api.linkFileSpace(s.root);h.host.api.setDefaultFileSpace(s.id)
  const source=join(s.dir,'source.txt');writeFileSync(source,'private')
  const [id]=await h.host.api.ingest([{type:'file',path:source}]);await h.host.scheduler.idle()
  const ref=String(h.host.store.blocksOf(id).file.data.path);h.host.close()
  const {cpSync}=await import('node:fs'),copy=join(s.dir,'copy.library');cpSync(h.root,copy,{recursive:true})
  expect(() => openHost(undefined,undefined,copy)).toThrow('SPACE_MEMBERSHIP_CONFLICT')
  rmSync(copy,{recursive:true});renameSync(h.root,copy)
  const moved=openHost(undefined,undefined,copy);cleanups.push(() => moved.host.close())
  moved.host.api.linkFileSpace(s.root)
  expect(readFileSync(moved.host.lib.files.readable(ref),'utf8')).toBe('private')
})
it('导入失败后按内容接续另一素材，不把未引用的空间文件误标为已收录', async () => {
  const {filePlugin}=await import('../../src/plugins/file/core')
  let fail=true
  const h=openHost([filePlugin,{id:'fail',version:1,afterIngest(){if(fail)throw new Error('business failed')}}]);cleanups.push(h.cleanup)
  const s=space();h.host.api.linkFileSpace(s.root);h.host.api.setDefaultFileSpace(s.id)
  const source=join(s.dir,'source.txt');writeFileSync(source,'same content')
  const request={operation:'import_files',requestId:'pending-import-dedupe',args:{paths:[source]}}
  await expect(h.host.api.executeOperation(request)).rejects.toThrow('FILE_STORED_NOT_ADOPTED')
  const first=(await page(h,s.id)).items[0];fail=false
  const other=await add(s.root,'other.txt','same content')
  const accepted=await adopt(h,s.id,other.id,other.revision,'other-file-adopted')
  expect((await h.host.api.executeOperation(request)).result).toMatchObject({items:[{id:(accepted.result as any).items[0].id,outcome:'existing'}]})
  expect((await page(h,s.id)).items.find(f=>f.id===first.id)?.collected).toBeUndefined()
  expect((await adopt(h,s.id,first.id,first.revision,'first-file-explicit')).result).toMatchObject({items:[{outcome:'created'}]})
})

it('已解除且删除目录的空间可移除记录，保留业务和引用；重开不再列出', async () => {
  const h=setup(),s=space(),file=await add(s.root)
  h.host.api.linkFileSpace(s.root)
  const id=((await adopt(h,s.id,file.id,file.revision)).result as any).items[0].id
  await h.host.scheduler.idle();h.host.api.put(id,'note',{text:'保留笔记'});await h.host.api.trash([id])
  const before=h.host.store.blocksOf(id).file.data
  const defaultId=embeddedSpace(h).id
  h.host.api.setImportSettings({defaultSpaceId:defaultId,collect:true,spaces:[{spaceId:s.id,automatic:true,updates:'automatic'}]})
  h.host.api.unlinkFileSpace(s.id);rmSync(s.root,{recursive:true})
  expect(h.host.api.previewForgetFileSpace(s.id)).toMatchObject({canForget:true,references:{active:0,trashed:1}})
  h.host.api.forgetFileSpace(s.id);h.host.api.forgetFileSpace(s.id)
  expect((await h.host.api.listFileSpaces()).some(row=>row.id===s.id)).toBe(false)
  expect(h.host.store.blocksOf(id).file.data).toEqual(before);expect(h.host.store.blocksOf(id).note.data.text).toBe('保留笔记')
  expect(h.host.store.isTrashed(id)).toBe(true)
  expect(JSON.parse(h.host.lib.db.prepare("SELECT value FROM config WHERE key='imports.v1'").pluck().get() as string).spaces).toEqual([])
  expect(h.host.lib.db.prepare('SELECT entity_id FROM space_adoptions WHERE space_id=?').pluck().get(s.id)).toBe(id)
  h.host.close();const next=openHost(undefined,undefined,h.root);cleanups.push(()=>next.host.close())
  expect((await next.host.api.listFileSpaces()).some(row=>row.id===s.id)).toBe(false)
  expect(next.host.store.blocksOf(id).note.data.text).toBe('保留笔记')
})
it('移除记录不代替解除；重新关联时沿用原素材，不恢复自动策略', async () => {
  const h=setup(),s=space(),file=await add(s.root);h.host.api.linkFileSpace(s.root)
  const id=((await adopt(h,s.id,file.id,file.revision)).result as any).items[0].id
  await h.host.scheduler.idle()
  expect(()=>h.host.api.forgetFileSpace(s.id)).toThrow('先完成解除')
  expect(()=>h.host.api.forgetFileSpace(embeddedSpace(h).id)).toThrow('随库')
  for (const state of ['pending','detaching']) {
    h.host.lib.db.prepare('UPDATE file_spaces SET state=? WHERE id=?').run(state,s.id)
    expect(()=>h.host.api.forgetFileSpace(s.id)).toThrow('先完成解除')
  }
  h.host.lib.db.prepare("UPDATE file_spaces SET state='active' WHERE id=?").run(s.id)
  h.host.api.setImportSettings({defaultSpaceId:embeddedSpace(h).id,collect:true,spaces:[{spaceId:s.id,automatic:true,updates:'automatic'}]})
  h.host.api.unlinkFileSpace(s.id);h.host.api.forgetFileSpace(s.id)
  h.host.api.linkFileSpace(s.root)
  expect((await h.host.api.getImportSettings()).spaces.some(rule=>rule.spaceId===s.id)).toBe(false)
  expect((await page(h,s.id)).items[0].collected).toBe(id)
  expect(readFileSync(h.host.lib.files.readable(String(h.host.store.blocksOf(id).file.data.path)),'utf8')).toBe('# shared')
  expect(((await adopt(h,s.id,file.id,file.revision,'after-forget-adoption')).result as any).items[0].id).toBe(id)
})


it('空间工作台先筛选再分页；回收、接纳使快照失效，计数与固定预览同源', async () => {
  const h = setup(), s = space()
  h.host.api.linkFileSpace(s.root)
  const files = [await add(s.root, 'Alpha.md', 'alpha'), await add(s.root, 'Älpha%_图.md', 'second'), await add(s.root, 'Rest.md', 'third')]
  const queries = new SpaceQueries(h.host.lib)
  const query = (input = {}) => queries.page({ spaceId: s.id, ...input })
  const first = query({ includeCounts: true, limit: 1 })
  expect(first.total).toBe(3); expect(first.nextOffset).toBe(1)
  expect(query({ limit: 1, offset: 1, snapshot: first.snapshot }).items).toHaveLength(1)
  expect(first.counts).toMatchObject({ active: 3, uncollected: 3, collected: 0, trashed: 0, outdated: 0 })
  expect(query({ search: 'äLPHA%_', limit: 1 }).items.map(f => f.id)).toEqual([files[1].id])
  expect(query({ search: 'absent' }).total).toBe(0)
  expect(query({ search: 'Alpha', includeCounts: true }).counts?.active).toBe(3)
  const ref = query().items.find(f => f.id === files[0].id)!.reference!
  const response = await serveLibraryFile(h.root, new Request('lib://library/' + ref))
  expect(await response.text()).toBe('alpha') // 尚未收录也可读取，但不创建素材。
  const id = ((await adopt(h, s.id, files[0].id, files[0].revision)).result as any).items[0].id
  expect(() => query({ offset: 1, snapshot: first.snapshot })).toThrow('SPACE_CHANGED')
  expect(query({ collectFilter: 'uncollected', limit: 1 }).total).toBe(2)
  const collected = query({ collectFilter: 'collected' })
  h.host.api.trash([id])
  expect(() => query({ collectFilter: 'collected', snapshot: collected.snapshot })).toThrow('SPACE_CHANGED')
  expect(query({ collectFilter: 'uncollected' }).total).toBe(2)
  expect(query({ collectFilter: 'trashed' }).items[0].collectionState).toBe('trashed')
  h.host.api.restore([id])
  const storage = new FileSpace(s.root), versions = new SpaceVersions(storage)
  try {
    const source = join(s.dir, 'Alpha.md'); writeFileSync(source, 'new alpha')
    const staged = await versions.stage({ spaceId: s.id, source, requestId: randomUUID(), target: { fileId: files[0].id, revision: files[0].revision } })
    await versions.commit({ spaceId: s.id, draftId: staged.draft.id, previewToken: versions.preview(staged.draft.id).previewToken, requestId: randomUUID() })
    const newer = query({ collectFilter: 'outdated', includeCounts: true })
    expect(newer.items.map(f => f.collected)).toEqual([id])
    expect(newer.counts).toMatchObject({ collected: 1, outdated: 1, trashed: 0, uncollected: 2 })
    expect((await h.host.api.getImportSettings()).bindings.find(b => b.id === s.id)?.uncollected).toBe(2)
    expect((await h.host.api.listFileSpaces({ includeCounts: true })).find(b => b.id === s.id)?.counts).toEqual(newer.counts)
    expect((await h.host.api.listFileSpaces()).find(b => b.id === s.id)?.counts).toBeUndefined()
    expect(await (await serveLibraryFile(h.root, new Request('lib://library/' + ref))).text()).toBe('alpha')
    expect(await (await serveLibraryFile(h.root, new Request('lib://library/' + newer.items[0].reference))).text()).toBe('new alpha')
    expect(await h.host.api.fileStorageInfo(id)).toMatchObject({ hasUpdate: true, canRevise: false, canRecycle: false })
    const preview = await h.host.api.previewFileUpdate(id)
    h.host.api.acceptFileUpdate({ id, expectedPath: preview.expectedPath, contentVersion: preview.current.id, revision: preview.revision, requestId: randomUUID() })
    expect(() => query({ collectFilter: 'outdated', snapshot: newer.snapshot })).toThrow('SPACE_CHANGED')
    expect(query({ collectFilter: 'outdated' }).total).toBe(0)
    setVersionPermission(storage, h.host.lib.id, 'revise', true, storage.info().revision)
    expect(await h.host.api.fileStorageInfo(id)).toMatchObject({ hasUpdate: false, canRevise: true, canRecycle: false })
    expect(() => new SpaceLifecycle(storage).page({ spaceId: s.id, collectFilter: 'uncollected' })).toThrow('LIBRARY_CONTEXT_REQUIRED')
    expect(() => query({ scope: 'recycled', collectFilter: 'outdated' })).toThrow('INVALID_INPUT')
  } finally { storage.close() }
  const missing = query().items.find(f => f.id === files[1].id)!
  rmSync(h.host.lib.files.readable(missing.reference!))
  expect(query({ search: 'äLPHA%_' }).items[0]).toMatchObject({ state: 'unavailable', collectionState: 'uncollected', reference: undefined })
  expect(query({ collectFilter: 'uncollected' }).total).toBe(2)
  h.host.api.unlinkFileSpace(s.id)
  expect((await serveLibraryFile(h.root, new Request('lib://library/' + ref))).status).toBe(403)
})
