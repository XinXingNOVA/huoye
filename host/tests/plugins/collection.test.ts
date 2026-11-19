import { afterEach, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'
import { corePlugins } from '../../src/plugins/core'
import { plugin as collection } from '@test-plugins/collection/core'
import { plugin as tags } from '@test-plugins/tags/core'
import { plugin as note } from '@test-plugins/note/core'
import type { Page, Summary } from '@test-plugins/collection/model'
import type { IngestResult } from '../../src/plugin-api/operations'

let current: ReturnType<typeof openHost> | undefined
const setup=()=> (current=openHost([...corePlugins,collection,tags,note])).host
afterEach(()=>{current?.cleanup();current=undefined})
type H=ReturnType<typeof setup>
const group=async(h:H,title='组',ids:string[]=[])=> (await h.api.run('collection','create',{title,ids}) as {id:string}).id
const item=async(h:H,text='素材')=>h.api.create({text:{content:text}})
const page=async(h:H,args:Record<string,unknown>,query='collection.members',extra={})=>(await h.api.executeQuery({query,args,...extra})).result as unknown as Page
const summary=async(h:H,id:string)=>(await h.api.executeQuery({query:'collection.summary',args:{id}})).result as unknown as Summary

it('组是独立普通素材，可搜索、附加信息；成员没有继承，也不计入组目录',async()=>{
  const h=setup(),a=await item(h),id=await group(h,'春日素材',[a])
  h.api.put(id,'tags',{values:['项目']});h.api.put(a,'tags',{values:['成员']});h.api.put(id,'note',{text:'组说明'})
  expect((await h.api.searchPage({query:{text:'春日素材'}})).items.map(r=>r.id)).toEqual([id])
  expect((await h.api.readContent({id,kind:'note',field:'text'})).text).toBe('组说明')
  expect(h.store.blocksOf(a).tags.data.values).toEqual(['成员'])
  expect((await page(h,{},'collection.list')).items).toEqual([{id,title:'春日素材'}])
  expect((await summary(h,id)).count).toBe(1)
  expect((await h.api.query({})).ids).toHaveLength(2)
})
it('移动覆盖归属，同组重复保留顺序；批量错误整体回滚，不允许组嵌套和管理记录',async()=>{
  const h=setup(),a=await item(h),b=await item(h,'第二项'),g=await group(h,'甲',[a]),other=await group(h,'乙')
  const before=h.store.blocksOf(a).collectionMember
  await h.api.run('collection','move',{ids:[a,a],group:g});expect(h.store.blocksOf(a).collectionMember).toEqual(before)
  for(const ids of [[a,g],[a,'missing'],Array(101).fill(a)])expect(()=>h.api.run('collection','move',{ids,group:other})).toThrow()
  expect(h.store.blocksOf(a).collectionMember).toEqual(before)
  const management=await h.api.create({tagGroups:{groups:[]}})
  expect(()=>h.api.run('collection','move',{ids:[management],group:g})).toThrow('INVALID_MEMBER')
  h.api.trash([b]);expect(()=>h.api.run('collection','move',{ids:[a,b],group:other})).toThrow('INVALID_MEMBER')
  await h.api.run('collection','move',{ids:[a],group:other});expect((await page(h,{group:g})).total).toBe(0)
  expect((await page(h,{group:other})).items[0].id).toBe(a)
  h.api.undo();expect(h.store.blocksOf(a).collectionMember.data).toEqual(before.data)
  await h.api.run('collection','move',{ids:[a],group:null});expect(h.store.blocksOf(a).collectionMember).toBeUndefined()
  expect((await page(h,{group:null})).items.map(x=>x.id)).toEqual([a])
  expect((await page(h,{},'collection.list')).total).toBe(2)
})
it('删除组保留成员和 link，未分组按有效目标判断；恢复不抢回已另行移动的成员',async()=>{
  const h=setup(),a=await item(h),b=await item(h,'第二项'),g=await group(h,'甲',[a,b]),other=await group(h,'乙')
  const req={operation:'collection_delete',requestId:'delete-group-01',args:{id:g}}
  const first=await h.api.executeOperation(req)
  expect(h.store.isTrashed(a)).toBe(false);expect(h.store.blocksOf(a).collectionMember.data.group).toBe(g)
  expect((await page(h,{group:null})).items.map(x=>x.id).sort()).toEqual([a,b].sort())
  expect(()=>h.api.executeQuery({query:'collection.members',args:{group:g}})).toThrow('NOT_FOUND')
  h.api.undo();expect((await page(h,{group:g})).total).toBe(2)
  expect(await h.api.executeOperation(req)).toEqual({...first,replayed:true});expect(h.store.isTrashed(g)).toBe(false)
  h.api.redo();await h.api.run('collection','move',{ids:[a],group:other});h.api.restore([g])
  expect((await page(h,{group:g})).items.map(x=>x.id)).toEqual([b])
  expect((await page(h,{group:other})).items.map(x=>x.id)).toEqual([a])
  h.api.trash([g]);await h.api.purge([g])
  expect(h.store.exists(g)).toBe(false);expect(h.store.blocksOf(b).collectionMember.data.group).toBe(g)
  expect((await page(h,{group:null})).items.map(x=>x.id)).toEqual([b])
})
it('组和成员排序可撤销；封面仅接受有效成员，失效回退，恢复自动',async()=>{
  const h=setup(),a=await item(h,'甲'),b=await item(h,'乙'),outside=await item(h,'外'),g=await group(h,'组',[a,b]),g2=await group(h,'第二组')
  await h.api.run('collection','reorder',{id:b,beforeId:a,group:g})
  expect((await page(h,{group:g})).items.map(x=>x.id)).toEqual([b,a]);expect((await summary(h,g)).coverId).toBe(b)
  h.api.undo();expect((await summary(h,g)).coverId).toBe(a)
  await h.api.run('collection','reorder',{id:g2,beforeId:g,group:null});expect((await page(h,{},'collection.list')).items.map(x=>x.id)).toEqual([g2,g])
  expect(()=>h.api.run('collection','setCover',{id:g,assetId:outside})).toThrow('本组成员')
  await h.api.run('collection','setCover',{id:g,assetId:b});expect((await summary(h,g)).coverId).toBe(b)
  h.api.trash([b]);expect((await summary(h,g))).toMatchObject({count:1,coverId:a})
  h.api.restore([b]);expect((await summary(h,g)).coverId).toBe(b)
  await h.api.run('collection','move',{ids:[b],group:g2});expect((await summary(h,g)).coverId).toBe(a)
  await h.api.run('collection','setCover',{id:g,assetId:null});expect(h.store.blocksOf(g).collection.data.cover).toBeUndefined()
  await h.api.run('collection','move',{ids:[a],group:null});expect((await summary(h,g))).toMatchObject({count:0,coverId:null,coverPath:null})
})
it('导入与其他插件协作，一次撤销、幂等重试；已有素材显式覆盖归属，失效目标整批回滚',async()=>{
  const h=setup(),g=await group(h,'甲'),other=await group(h,'乙'),path=join(current!.root,'新文件.txt')
  writeFileSync(path,'Collection new file')
  const req={operation:'import_files',requestId:'import-collection-1',args:{files:[{path,metadata:{'collection.join':{group:g,order:10},'tags.set':{values:['素材']},'note.initial':{text:'成员笔记'}}}]}}
  const first=await h.api.executeOperation(req),id=(first.result as IngestResult).items[0].id
  expect(h.store.blocksOf(id).collectionMember.data).toEqual({group:g,order:10});expect(h.store.blocksOf(id).note.data.text).toBe('成员笔记')
  expect(await h.api.executeOperation(req)).toEqual({...first,replayed:true})
  h.api.undo();expect(h.store.isTrashed(id)).toBe(true);h.api.redo()
  const request=(target:string,requestId:string)=>({operation:'import_files',requestId,args:{files:[{path,metadata:{'collection.join':{group:target,order:1}}}]}})
  await h.api.executeOperation(request(other,'move-existing'));expect(h.store.blocksOf(id).collectionMember.data).toEqual({group:other,order:1})
  h.api.undo();expect(h.store.blocksOf(id).collectionMember.data.group).toBe(g)
  h.api.trash([other]);await expect(h.api.executeOperation(request(other,'bad-target'))).rejects.toThrow('INGEST_METADATA_FAILED')
  expect(h.store.blocksOf(id).collectionMember.data.group).toBe(g)
  expect(h.lib.db.prepare('SELECT count(*) FROM operation_receipt WHERE request_id=?').pluck().get('bad-target')).toBe(0)
})
it('分页不丢成员，支持组名与全文搜索；数据变化后拒绝旧游标',async()=>{
  const h=setup(),a=await item(h,'独特词甲'),b=await item(h,'乙'),g=await group(h,'检索组',[a,b])
  const one=await page(h,{group:g},'collection.members',{limit:1}),two=await page(h,{group:g},'collection.members',{limit:1,cursor:one.nextCursor!})
  expect([...one.items,...two.items].map(x=>x.id)).toEqual([a,b]);expect(two.nextCursor).toBeNull()
  expect((await page(h,{group:g,text:'独特词甲'})).items.map(x=>x.id)).toEqual([a])
  expect((await page(h,{text:'检索'},'collection.list')).items.map(x=>x.id)).toEqual([g])
  await h.api.run('collection','rename',{id:g,title:'改名'})
  expect(()=>h.api.executeQuery({query:'collection.members',args:{group:g},limit:1,cursor:one.nextCursor!})).toThrow('STALE_CURSOR')
})
it('仅本体与组插件也能使用，不依赖标签笔记；停用后原始数据仍可读取，重启后恢复',async()=>{
  const h=setup(),a=await item(h),g=await group(h,'保留',[a]),root=current!.root
  h.close();current=undefined
  const bare=openHost(corePlugins,{},root)
  try{expect((await bare.host.api.readItem({id:g}))).toBeTruthy();expect(bare.host.store.blocksOf(a).collectionMember.data.group).toBe(g)}finally{bare.host.close()}
  current=openHost([...corePlugins,collection],{},root)
  expect((await summary(current.host,g)).count).toBe(1)
  await group(current.host,'无可选依赖')
})
it('超过 V1 列表预算明确报错，缩小组名搜索后可读，不静默漏项',async()=>{
  const h=setup()
  h.store.batch(()=>{for(let i=0;i<4001;i++){const id=h.store.createEntity();h.store.put(id,'collection',{title:i===0?'唯一命中':'其他组',order:i})}})
  expect(()=>h.api.executeQuery({query:'collection.list'})).toThrow('COLLECTION_LIMIT')
  expect((await page(h,{text:'唯一命中'},'collection.list')).total).toBe(1)
})
it('MCP 恢复闭环，重复恢复不抢回已移动成员；空组可筛选而不删除',async()=>{
  const h=setup(),a=await item(h),b=await item(h,'第二项'),g=await group(h,'甲',[a,b]),other=await group(h,'乙'),empty=await group(h,'空组')
  await h.api.executeOperation({operation:'collection_delete',requestId:'collection-delete-cycle',args:{id:g}})
  await h.api.run('collection','move',{ids:[a],group:other})
  const req={operation:'collection_restore',requestId:'collection-restore-cycle',args:{id:g}}
  const restored=await h.api.executeOperation(req)
  expect((await page(h,{group:g})).items.map(x=>x.id)).toEqual([b])
  expect((await page(h,{group:other})).items.map(x=>x.id)).toEqual([a])
  expect(await h.api.executeOperation(req)).toEqual({...restored,replayed:true})
  h.api.undo();expect(h.store.isTrashed(g)).toBe(true);h.api.redo();expect(h.store.isTrashed(g)).toBe(false)
  const all=await page(h,{},'collection.list'),filtered=await page(h,{hideEmpty:true},'collection.list')
  expect(all.total).toBe(3);expect(filtered.items.map(x=>x.id).sort()).toEqual([g,other].sort());expect(h.store.exists(empty)).toBe(true)
  expect(()=>h.api.run('collection','restore',{id:a})).toThrow('NOT_FOUND')
  h.api.trash([empty]);await h.api.purge([empty]);expect(()=>h.api.run('collection','restore',{id:empty})).toThrow('NOT_FOUND')
})
it('按批次 ID 限定成员，空 ID 不扩大范围；名称候选仅返回当前页',async()=>{
  const h=setup(),a=await item(h,'甲'),b=await item(h,'乙'),c=await item(h,'丙'),g=await group(h,'组',[a])
  expect((await page(h,{group:null,ids:[a,b,b,'missing']})).items.map(x=>x.id)).toEqual([b])
  expect((await page(h,{group:null,ids:[]})).total).toBe(0)
  expect((await page(h,{group:g,ids:[b]})).total).toBe(0)
  h.api.trash([g]);expect((await page(h,{group:null,ids:[a]})).items.map(x=>x.id)).toEqual([a])
  await h.api.run('collection','restore',{id:g});expect((await page(h,{group:null,ids:[a]})).total).toBe(0)
  const result=(await h.api.executeQuery({query:'collection.members',args:{group:null,ids:[b,c]},limit:1})).result
  const rows=result.items as {id:string}[]
  expect(Object.keys(result.titleCandidates as object)).toEqual([rows[0].id])
  expect((result.titleCandidates as Record<string,unknown[]>)[rows[0].id]).toMatchObject([{kind:'text',field:'content'}])
})
