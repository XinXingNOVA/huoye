import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'
import { defaultTaskLimits } from '../../src/shared/library-task'
import type { ReviewPage } from '../../src/shared/batch-review'

let fixture: ReturnType<typeof openHost>
afterEach(() => fixture?.cleanup())
const taskId = 'visual-intake'

it('重开后区分未试、失败和已经收录；重试留存错误，重放回执不增加尝试', async () => {
  fixture = openHost()
  const { root, host } = fixture, paths = ['one.txt','two.txt','three.txt'].map(name => join(root,name))
  const plan = { action: 'create' as const, taskId, title: '测试素材', inputs: paths }
  const request = { taskId, requestId: 'intake-first', files: paths.slice(0,2).map(path => ({path})) }
  writeFileSync(paths[0], '一')
  host.api.libraryTask(plan)
  expect(host.api.libraryTask(plan)).toMatchObject({ task: { inputCount: 3 } })
  expect(() => host.api.libraryTask({...plan,inputs:[paths[2]]})).toThrow('TASK_CONFLICT')
  await expect(host.api.importFiles({...request,files:[{path: join(root,'未登记')}] })).rejects.toThrow('TASK_INPUT_UNKNOWN')
  const result = await host.api.importFiles(request)
  host.close()
  fixture = openHost(undefined,undefined,root)
  const { api } = fixture.host
  expect(api.libraryTask({action:'get',taskId})).toMatchObject({inputs:[
    {state:'created',entityId:result.items[0].id},{state:'failed',error:expect.stringContaining('ENOENT')},{state:'unattempted',requestId:null}
  ]})
  writeFileSync(paths[1], '二')
  expect(await api.importFiles(request)).toEqual(result)
  await api.importFiles({...request,requestId:'intake-second',files:[{path:paths[1]}]})
  expect(api.libraryTask({action:'get',taskId,section:'attempts',offset:1})).toMatchObject({attempts:[
    {state:'failed',requestId:'intake-first',attemptNo:1},{state:'created',requestId:'intake-second',attemptNo:2}
  ]})
})

it('同一请求遇到事务失败后可安全接续，同时保留失败和成功两次尝试', async () => {
  fixture = openHost()
  const { host, root } = fixture, path = join(root, '原稿.txt')
  writeFileSync(path, '第一次提交时回滚')
  host.api.libraryTask({ action: 'create', taskId, title: '接续', inputs: [path] })
  const request = { taskId, requestId: 'retry-original', files: [{path}] }
  host.lib.db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON main.operation_receipt BEGIN SELECT RAISE(ABORT,'test rollback'); END")
  await expect(host.api.importFiles(request)).rejects.toThrow('test rollback')
  host.lib.db.exec('DROP TRIGGER temp.fail_receipt')
  await host.api.importFiles(request)
  await host.api.importFiles(request)
  expect(host.api.libraryTask({ action:'get', taskId, section:'attempts' })).toMatchObject({
    attempts: [{ attemptNo:1, state:'failed', error:expect.stringContaining('test rollback') }, { attemptNo:2, state:'created', error:null }]
  })
})

it('草稿和命令一起提交；重开后组单仍保留后来被改回同值的标签，撤回与重放只生效一次', async () => {
  fixture = openHost()
  const { root,host } = fixture
  const [id] = await host.api.ingest([{type:'text',text:'待验收'}])
  host.api.libraryTask({action:'create',taskId,title:'人工校色',inputs:[join(root,'原图.png')]})
  const write = (requestId: string, add: string[]) => host.api.executeOperation({taskId,requestId,operation:'update_tags',args:{ids:[id],add}})
  host.lib.db.exec("CREATE TEMP TRIGGER fail_draft BEFORE INSERT ON main.task_write BEGIN SELECT RAISE(ABORT,'test draft rollback'); END")
  expect(() => write('before-edit',['红色'])).toThrow('test draft rollback')
  expect(host.store.blocksOf(id).tags).toBeUndefined()
  host.lib.db.exec('DROP TRIGGER temp.fail_draft')
  await write('before-edit',['红色'])
  await write('keep-no-op',['红色'])
  await host.api.patch(id,'tags',{values:['人工']})
  await host.api.patch(id,'tags',{values:['红色']})
  await write('after-edit',['蓝色'])
  expect(host.api.reviewBatch({action:'list'})).toMatchObject({batches:[]})
  const retry = await write('after-edit',['蓝色'])
  expect(retry.replayed).toBe(true)
  host.close()
  fixture = openHost(undefined,undefined,root)
  const api = fixture.host.api, requestIds=['after-edit','before-edit','keep-no-op']
  expect(api.libraryTask({action:'get',taskId,section:'writes'})).toMatchObject({writes:requestIds.map(()=>({reviewState:'draft',batchId:null}))})
  expect(api.libraryTask({action:'diff',taskId,requestId:'before-edit'})).toMatchObject({ draft: {items:[{id,changes:[{ member:'红色', before:false, after:true, preserved:true, currentPreview:true }]}]} })
  const create={action:'create' as const,title:'检查标签',requestIds}
  const sheet=api.reviewBatch(create) as ReviewPage
  expect(sheet.batch).toMatchObject({preserved:1,changes:2,unchangedRequests:['keep-no-op']})
  expect((api.reviewBatch(create) as ReviewPage).batch.id).toBe(sheet.batch.id)
  expect(api.libraryTask({action:'get',taskId,section:'writes'})).toMatchObject({writes:requestIds.map(()=>({reviewState:'pending',batchId:sheet.batch.id}))})
  api.reviewBatch({action:'withdraw',batchId:sheet.batch.id})
  expect(fixture.host.store.blocksOf(id).tags.data.values).toEqual(['红色'])
})

it('上限按库及逐文件尝试计数，拒绝整批且可继续送审、结束和释放名额', async () => {
  fixture = openHost()
  const { host, root } = fixture, api = host.api
  const paths = ['一.txt', '二.txt'].map(name => join(root, name))
  paths.forEach(path => writeFileSync(path, path))
  const request = { taskId, files: paths.map(path => ({ path })), requestId: 'quota-inputs' }
  const plan = { action: 'create' as const, taskId, title: '限制', inputs: paths }
  const limits = { tasks: 1, attempts: 1, writes: 2, drafts: 1 }
  api.taskCapacity(limits)
  api.libraryTask(plan)
  expect(() => api.libraryTask({ ...plan, taskId: 'different-task' })).toThrow('TASK_LIMIT')
  expect(() => api.libraryTask({ action: 'complete', taskId })).toThrow('TASK_INCOMPLETE')
  await expect(api.importFiles(request)).rejects.toThrow('TASK_LIMIT')
  expect(api.libraryTask({ action: 'get', taskId, section: 'attempts' })).toMatchObject({ attempts: [] })
  api.taskCapacity({ ...limits, attempts: 2 })
  const ongoing = api.importFiles(request)
  expect(() => api.libraryTask({ action: 'abandon', taskId })).toThrow('TASK_BUSY')
  const result = await ongoing
  const id = result.items[0].id
  const write = (requestId: string, tag: string) => api.executeOperation({ taskId, requestId, operation: 'update_tags', args: { ids: [id], add: [tag] } })
  await write('quota-write1', '正式')
  expect(() => write('quota-write2', '草稿')).toThrow('TASK_LIMIT')
  expect(host.store.blocksOf(id).tags.data.values).toEqual(['正式'])
  const stale = await api.previewTaskCleanup({ taskId, mode:'drafts' })
  expect(() => api.libraryTask({ action:'complete', taskId })).toThrow('TASK_DRAFTS')
  const submitted = { action:'create' as const, title:'已交付', requestIds:['quota-write1'] }
  const { batch } = api.reviewBatch(submitted) as ReviewPage
  await write('quota-write2', '草稿')
  expect(() => api.cleanTask({ taskId, mode:'drafts' }, stale.revision)).toThrow('PREVIEW_CHANGED')
  const target = { taskId, mode:'drafts' as const, requestId:'quota-write2' }
  api.cleanTask(target, (await api.previewTaskCleanup(target)).revision)
  expect(() => write('quota-write3', '越界')).toThrow('TASK_LIMIT')
  expect(() => api.reviewBatch({ ...submitted, requestIds:['quota-write2'] })).toThrow('REVIEW_UNAVAILABLE')
  const closed = api.libraryTask({ action:'complete', taskId })
  expect(api.libraryTask({ action:'complete', taskId })).toEqual(closed)
  expect(() => api.libraryTask({ action:'abandon', taskId })).toThrow('TASK_CLOSED')
  await expect(api.importFiles({ ...request, requestId:'fresh-import' })).rejects.toThrow('TASK_CLOSED')
  expect(await api.importFiles(request)).toEqual(result)
  expect((await write('quota-write2', '草稿')).replayed).toBe(true)
  const records = { taskId, mode:'records' as const }
  const cleanup = await api.previewTaskCleanup(records)
  expect(cleanup).toMatchObject({ inputs:2, attempts:2, writes:2, drafts:0, reviews:1 })
  expect(await api.taskMarkerUsage()).toEqual({ tasks:0, requests:0, estimatedBytes:0 })
  api.cleanTask(records, cleanup.revision)
  expect(await api.taskMarkerUsage()).toEqual({ tasks:1, requests:3, estimatedBytes:185 })
  expect(api.taskCapacity()).toMatchObject({ tasks:0, drafts:0 })
  expect((api.reviewBatch(submitted) as ReviewPage).batch.id).toBe(batch.id)
  api.reviewBatch({ action:'withdraw', batchId:batch.id })
  expect(host.store.blocksOf(id).tags.data.values).toEqual(['草稿'])
  expect(() => api.reviewBatch({ ...submitted, requestIds:['quota-write2'] })).toThrow('REVIEW_UNAVAILABLE')
  expect(() => api.libraryTask(plan)).toThrow('TASK_CLEANED')
  expect(() => write('quota-write2', '草稿')).toThrow('TASK_CLEANED')
  await expect(api.importFiles(request)).rejects.toThrow('TASK_CLEANED')
  api.libraryTask({ ...plan, taskId: 'different-task' })
  expect(readFileSync(paths[0], 'utf8')).toBe(paths[0])
})

it('放弃保留未送审差异，单份草稿可单独丢弃，整项清理仅释放此任务与中断导入的准备记录', async () => {
  fixture = openHost()
  const { host, root } = fixture, api = host.api, db = host.lib.db
  const path = join(root,'未交付.txt'), other = 'other-retained'
  writeFileSync(path, '原稿')
  for (const id of [taskId, other]) api.libraryTask({ action:'create', taskId:id, title:'未交付', inputs:[path] })
  expect(() => api.previewTaskCleanup({ taskId, mode:'records' })).toThrow('TASK_ACTIVE')
  const [id] = await api.ingest([{ type:'text', text:'分类' }])
  for (const [task, request] of [[taskId,'discard-one'], [taskId,'keep-draft'], [other,'other-draft']])
    await api.executeOperation({ taskId:task, requestId:request, operation:'update_tags', args:{ ids:[id], add:[request] } })
  const req = { taskId, requestId:'failed-preparation', files:[{path}] }
  db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON main.operation_receipt BEGIN SELECT RAISE(ABORT,'未提交'); END")
  await expect(api.importFiles(req)).rejects.toThrow('未提交')
  db.exec('DROP TRIGGER temp.fail_receipt')
  const closed = api.libraryTask({ action:'abandon', taskId })
  host.close()
  fixture = openHost(undefined,undefined,root)
  const next = fixture.host.api, reopened = fixture.host.lib.db
  expect(next.libraryTask({ action:'abandon', taskId })).toEqual(closed)
  next.taskCapacity({ ...defaultTaskLimits, tasks:1, drafts:1 })
  const single = { taskId, mode:'drafts' as const, requestId:'discard-one' }
  const first = await next.previewTaskCleanup(single)
  expect(first).toMatchObject({ drafts:1, preparations:1 })
  next.cleanTask(single, first.revision)
  expect(next.libraryTask({ action:'get', taskId, section:'writes' })).toMatchObject({ writes:[{ reviewState:'discarded' }, { reviewState:'draft' }] })
  const target = { taskId, mode:'records' as const }, plan = await next.previewTaskCleanup(target)
  expect(plan).toMatchObject({ state:'abandoned', attempts:1, errors:1, preparations:1, drafts:1, writes:2 })
  const offline = vi.spyOn(fixture.host.lib.files.bindings!, 'open').mockImplementationOnce(() => { throw new Error('空间离线') })
  expect(() => next.cleanTask(target, plan.revision)).toThrow('空间离线')
  offline.mockRestore()
  expect(await next.previewTaskCleanup(target)).toEqual(plan)
  next.cleanTask(target, plan.revision)
  expect(reopened.prepare('SELECT result FROM main.operation_receipt WHERE request_id=?').pluck().get(req.requestId)).toBe('')
  expect(next.libraryTask({ action:'get', taskId:other, section:'writes' })).toMatchObject({ writes:[{ reviewState:'draft' }] })
  expect(reopened.prepare('SELECT 1 FROM main.ingest_pending WHERE key=?').get('mcp:'+req.requestId)).toBeUndefined()
  const space = fixture.host.lib.files.bindings!.default().space
  expect(space.db.prepare('SELECT 1 FROM version_import_batches WHERE key=?').get(fixture.host.lib.id+':mcp:'+req.requestId)).toBeUndefined()
  await expect(next.importFiles(req)).rejects.toThrow('TASK_CLEANED')
  await expect(next.importFiles({ requestId:req.requestId, files:req.files })).rejects.toThrow('TASK_CLEANED')
  expect(next.taskCapacity()).toMatchObject({ tasks:1, drafts:1 })
  expect(fixture.host.store.blocksOf(id).tags.data.values).toEqual(['discard-one','keep-draft','other-draft'])
})

it('旧任务升级后仍可读、结束和清理，调整上限后重开仍生效', async () => {
  fixture = openHost()
  const { host, root } = fixture, path=join(root, '旧图片.png')
  host.api.libraryTask({ action:'create', taskId, title:'旧任务', inputs:[path] })
  host.api.taskCapacity({ ...defaultTaskLimits, tasks:7 })
  host.lib.db.exec('ALTER TABLE main.library_task DROP COLUMN state; ALTER TABLE main.library_task DROP COLUMN ended')
  host.close()
  fixture = openHost(undefined, undefined, root)
  const api=fixture.host.api
  expect((await api.taskCapacity()).limits.tasks).toBe(7)
  expect(api.libraryTask({ action:'get', taskId })).toMatchObject({task:{state:'active',endedAt:null}, inputs:[{path,state:'unattempted'}]})
  const closed=api.libraryTask({ action:'abandon', taskId })
  expect(closed).toMatchObject({ task:{state:'abandoned',endedAt:expect.any(Number)} })
  const target={ taskId, mode:'records' as const }
  api.cleanTask(target, (await api.previewTaskCleanup(target)).revision)
  expect(api.libraryTask({ action:'list' })).toMatchObject({ tasks:[] })
})
