import { pluginSource } from '../helpers/plugin-sources'
import { afterEach, expect, it } from 'vitest'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { openHost, tempDir } from '../helpers/helpers'
import { corePlugins } from '../../src/plugins/core'
import { plugin as tags } from '@test-plugins/tags/core'
import { plugin as note } from '@test-plugins/note/core'
import { plugin as source } from '@test-plugins/source/core'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'
import type { IngestResult } from '../../src/plugin-api/operations'
import type { IngestMetadataContext } from '../../src/plugin-api/ingest'
import { Registry } from '../../src/core/registry'
import { packPlugin } from '../../scripts/plugins/pack'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { loadExternalCore, setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import { Host } from '../../src/core/host'
import { filePlugin } from '../../src/plugins/file/core'

let current: ReturnType<typeof openHost> | undefined
const roots: string[] = []
afterEach(() => { current?.cleanup(); current = undefined; roots.splice(0).forEach(p => rmSync(p,{recursive:true,force:true})) })
const plugins = [...corePlugins, tags, note, source]
const setup = (list = plugins) => (current = openHost(list)).host
const file = (name='test.txt', text='new file') => { const path=join(current!.root,name);writeFileSync(path,text);return path }
const metadata = { 'tags.add':{add:['阅读',' 阅读 ','参考']}, 'note.initial':{text:'  保留缩进\n'}, 'source.initial':{url:'https://example.com/book',title:'书籍来源'} }
async function run(path: string, data: Record<string,unknown> = metadata, requestId='metadata-import') {
  return current!.host.api.executeOperation({operation:'import_files',requestId,args:{files:[{path,metadata:data}]}})
}
it('能力发现、完整收录与加工，重试不重放写入，一次撤销及重做',async()=>{
  const h=setup(),path=file(),description=await h.api.describeLibrary()
  expect(description.ingestMetadata.map(x=>x.id).sort()).toEqual(['note.initial','source.initial','tags.add','tags.set'])
  expect(description.ingestMetadata.every(x=>x.inputSchema.type==='object')).toBe(true)
  const [first,replay]=await Promise.all([run(path),run(path)])
  expect(replay).toEqual({...first,replayed:true})
  const result=first.result as IngestResult,id=result.items[0].id
  expect(result.items[0].metadata).toEqual({'tags.add':{status:'applied'},'note.initial':{status:'applied'},'source.initial':{status:'applied'}})
  expect(h.store.blocksOf(id).tags.data.values).toEqual(['阅读','参考'])
  expect(h.store.blocksOf(id).note.data.text).toBe('  保留缩进\n')
  expect(h.store.blocksOf(id).source.data.site).toBe('example.com')
  await h.scheduler.idle();expect(h.store.blocksOf(id).body.data.content).toContain('new file')
  expect(readFileSync(path,'utf8')).toBe('new file')
  expect(h.api.undo()).toContain('收录');expect(h.store.isTrashed(id)).toBe(true)
  expect((await run(path)).replayed).toBe(true);expect(h.store.isTrashed(id)).toBe(true)
  h.api.redo();expect(h.store.blocksOf(id).tags.data.values).toEqual(['阅读','参考'])
  expect(()=>h.api.executeOperation({operation:'import_files',requestId:'metadata-import',args:{paths:[path]}})).toThrow('REQUEST_ID_CONFLICT')
})
it('已有和恢复的素材合并标签、保护笔记来源，同批重复文件按最新内容处理并整体撤销',async()=>{
  const h=setup(),path=file(),[id]=await h.api.ingest([{type:'file',path}])
  h.api.put(id,'note',{text:'用户笔记'});h.api.put(id,'source',{url:'https://old.example.com',site:'old.example.com'})
  h.api.put(id,'tags',{values:['已有']})
  const before=h.store.blocksOf(id)
  const result=(await h.api.executeOperation({operation:'import_files',requestId:'duplicate-with-meta',args:{files:[{path,metadata},{path,metadata:{'tags.add':{add:['再次']},'note.initial':{text:'第三份'}}}]}})).result as IngestResult
  expect(result.items.map(x=>x.outcome)).toEqual(['existing','existing'])
  expect(result.items[0].metadata?.['note.initial'].status).toBe('preserved')
  expect(result.items[0].metadata?.['source.initial'].status).toBe('preserved')
  expect(h.store.blocksOf(id).note.data.text).toBe('用户笔记')
  expect(h.store.blocksOf(id).tags.data.values).toEqual(['已有','阅读','参考','再次'])
  h.api.undo();expect(h.store.blocksOf(id).tags.data).toEqual(before.tags.data)
  h.api.trash([id]);const restored=(await run(path)).result as IngestResult
  expect(restored.items[0].outcome).toBe('restored');expect(h.store.isTrashed(id)).toBe(false)
  h.api.undo();expect(h.store.isTrashed(id)).toBe(true);expect(h.store.blocksOf(id).note.data.text).toBe('用户笔记')
})
it('多文件附加内容独立，普通文件错误逐项报告，成功项一起撤销',async()=>{
  const h=setup(),a=file(),b=file('second.txt','second')
  const result=(await h.api.executeOperation({operation:'import_files',requestId:'partial-meta-files',args:{files:[
    {path:a,metadata:{'tags.add':{add:['A']}}},{path:b,metadata:{'tags.add':{add:['B']}}},{path:join(current!.root,'missing'),metadata}
  ]}})).result as IngestResult
  expect(result.errors.map(x=>x.index)).toEqual([2]);expect(result.items).toHaveLength(2)
  expect(result.items.map(x=>h.store.blocksOf(x.id).tags.data.values)).toEqual([['A'],['B']])
  h.api.undo();expect(result.items.every(x=>h.store.isTrashed(x.id))).toBe(true)
})
it('未知、停用或不合法的附加能力在复制前整次拒绝，不生成回执',async()=>{
  const h=setup(plugins.filter(p=>p.id!=='tags')),path=file()
  expect((await h.api.describeLibrary()).ingestMetadata.some(x=>x.id==='tags.add')).toBe(false)
  for(const data of [metadata,{'source.initial':{url:'file:///etc/a'}},{'note.initial':{text:' ' }},{'note.initial':{text:'x',overwrite:true}}]) {
    await expect(run(path,data)).rejects.toThrow(/INGEST_METADATA/)
  }
  await expect(h.api.executeOperation({operation:'import_files',requestId:'later-invalid-metadata',args:{files:[
    {path,metadata:{'note.initial':{text:'前项合法'}}},{path,metadata:{'unknown.initial':{}}}
  ]}})).rejects.toThrow('UNAVAILABLE_INGEST_METADATA')
  expect((await h.api.query({})).ids).toEqual([])
  expect(h.lib.db.prepare('SELECT count(*) FROM operation_receipt').pluck().get()).toBe(0)
  expect(h.lib.files.bindings!.default().space.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(0)
})
it('UI 导入与 bytes 共用协议，显式来源优先于旧剪贴板提示；旧 paths 保持兼容',async()=>{
  const h=setup(),[id]=await h.api.ingest([{type:'bytes',name:'paste.txt',bytes:new TextEncoder().encode('pasted'),metadata,source:{url:'https://clipboard.example.com'}}])
  expect(h.store.blocksOf(id).source.data.url).toBe('https://example.com/book')
  const result=(await h.api.executeOperation({operation:'import_files',requestId:'old-paths-compatible',args:{paths:[file('other.txt')]}})).result as IngestResult
  expect(result.items[0]).not.toHaveProperty('metadata')
})
it('提交失败回滚业务数据与回执，空间保留新文件；拒绝跨插件写入',async()=>{
  const broken:CorePlugin={id:'broken',version:1,ingestMetadata:[{id:'broken.fail',title:'失败',description:'测试失败',input:z.object({}).strict(),apply(ctx){ctx.put('note',{text:'越界'});return {status:'applied'}}}]}
  const h=setup([...plugins,broken]),path=file()
  const [id]=await h.api.ingest([{type:'file',path}]);h.api.put(id,'tags',{values:['原有']})
  await h.scheduler.idle()
  const before=h.store.get([id]),fresh=file('fresh.txt','fresh content')
  await expect(h.api.executeOperation({operation:'import_files',requestId:'metadata-rollback',args:{files:[{path,metadata},{path:fresh,metadata:{'broken.fail':{}}}]}})).rejects.toThrow(/不能写入 note/)
  expect(h.store.get([id])).toEqual(before);expect((await h.api.query({})).ids).toEqual([id])
  expect(h.lib.db.prepare('SELECT count(*) FROM operation_receipt').pluck().get()).toBe(0)
  expect(h.lib.files.bindings!.default().space.db.prepare("SELECT count(*) FROM files WHERE state='available'").pluck().get()).toBe(2)
  expect(h.lib.db.prepare('SELECT count(*) FROM ingest_pending').pluck().get()).toBe(1)
})
it('上下文不允许处理器返回后写入；只允许本插件普通持久块',async()=>{
  let later:(()=>void)|undefined
  const custom:CorePlugin={id:'custom',version:1,blocks:[{id:'custom.info',plugin:'custom',title:'信息',version:1,rebuildable:false,fields:{value:{type:'text',title:'值'}}}],ingestMetadata:[{id:'custom.info',title:'信息',description:'写信息',input:z.object({}),apply(ctx){later=()=>ctx.put('custom.info',{value:'迟到'});ctx.put('custom.info',{value:'及时'});return{status:'applied'}}}]}
  const h=setup([...plugins,custom]),result=(await run(file(),{'custom.info':{}})).result as IngestResult
  expect(()=>later!()).toThrow('已经结束');expect(h.store.blocksOf(result.items[0].id)['custom.info'].data.value).toBe('及时')
  expect(()=>new Registry([{...custom,ingestMetadata:[{...custom.ingestMetadata![0],id:'other.info'}]}])).toThrow('ID')
})
it('异步文件准备期间的用户编辑在提交时重新读取，不被初始笔记覆盖',async()=>{
  let wait=false,release!:()=>void,started!:()=>void
  const began=new Promise<void>(r=>{started=r}),gate=new Promise<void>(r=>{release=r})
  const slow:CorePlugin={...filePlugin,recognizers:[{...filePlugin.recognizers![0],async ingest(ctx,input){
    const id=await filePlugin.recognizers![0].ingest(ctx,input)
    if(wait){started();await gate}return id
  }}]}
  const h=setup([...plugins.filter(p=>p.id!=='file'),slow]),path=file(),[id]=await h.api.ingest([{type:'file',path}])
  wait=true
  const pending=run(path)
  await began
  h.api.put(id,'note',{text:'刚刚编辑的笔记'})
  release()
  const result=(await pending).result as IngestResult
  expect(result.items[0].metadata?.['note.initial'].status).toBe('preserved')
  h.api.undo();expect(h.store.blocksOf(id).note.data.text).toBe('刚刚编辑的笔记')
})
it('拒绝异步处理器并回滚同步写入，异步续写也不能逃出事务',async()=>{
  let lateError=''
  const custom:CorePlugin={id:'custom',version:1,blocks:[{id:'custom.info',plugin:'custom',title:'信息',version:1,rebuildable:false,fields:{value:{type:'text',title:'值'}}}],ingestMetadata:[{
    id:'custom.info',title:'信息',description:'异步违规',input:z.object({}),
    // 模拟绕过 TypeScript 的外部包实现。
    apply: (async(ctx: IngestMetadataContext)=>{
      ctx.put('custom.info',{value:'同步部分'})
      await Promise.resolve()
      try{ctx.put('custom.info',{value:'异步部分'})}catch(e){lateError=String(e)}
      return{status:'applied'}
    }) as unknown as NonNullable<CorePlugin['ingestMetadata']>[number]['apply']
  }]}
  const h=setup([...plugins,custom])
  await expect(run(file(),{'custom.info':{}})).rejects.toThrow('必须同步执行')
  expect(lateError).toContain('已经结束');expect((await h.api.query({})).ids).toEqual([])
  expect(h.api.undo()).toBeNull()
})
it('tags.set 整体替换标签、空数组清空，与 tags.add 互斥',async()=>{
  const h=setup(),path=file('set.txt','set content')
  const first=(await run(path,{'tags.set':{values:['体态:坐姿',' 体态:坐姿 ','次元:三次元']}},'set-apply')).result as IngestResult
  const id=first.items[0].id
  expect(first.items[0].metadata).toEqual({'tags.set':{status:'applied'}})
  expect(h.store.blocksOf(id).tags.data.values).toEqual(['体态:坐姿','次元:三次元'])
  const same=(await run(path,{'tags.set':{values:['体态:坐姿','次元:三次元']}},'set-unchanged')).result as IngestResult
  expect(same.items[0].outcome).toBe('existing')
  expect(same.items[0].metadata?.['tags.set'].status).toBe('unchanged')
  const replaced=(await run(path,{'tags.set':{values:['体态:站姿']}},'set-replace')).result as IngestResult
  expect(replaced.items[0].metadata?.['tags.set'].status).toBe('applied')
  expect(h.store.blocksOf(id).tags.data.values).toEqual(['体态:站姿'])
  h.api.undo();expect(h.store.blocksOf(id).tags.data.values).toEqual(['体态:坐姿','次元:三次元'])
  await expect(run(path,{'tags.add':{add:['新']},'tags.set':{values:['新']}},'set-conflict')).rejects.toThrow('INGEST_METADATA_FAILED')
  expect(h.store.blocksOf(id).tags.data.values).toEqual(['体态:坐姿','次元:三次元'])
  const cleared=(await run(path,{'tags.set':{values:[]}},'set-clear')).result as IngestResult
  expect(cleared.items[0].metadata?.['tags.set'].status).toBe('applied')
  expect(h.store.blocksOf(id).tags.data.values).toEqual([])
})
it('tags 意图即使其中一步无变化也互斥；同值设置不改块序号',async()=>{
  const h=setup(),path=file('noop.txt','noop test')
  const first=(await run(path,{'tags.set':{values:['A']}},'noop-init')).result as IngestResult,id=first.items[0].id
  const before=h.store.blocksOf(id).tags
  await run(path,{'tags.set':{values:['A']}},'noop-same')
  expect(h.store.blocksOf(id).tags).toEqual(before)
  for (const [i, metadata] of [
    {'tags.add':{add:['A']},'tags.set':{values:['B']}},
    {'tags.add':{add:['B']},'tags.set':{values:['A','B']}},
    {'tags.add':{add:['A']},'tags.set':{values:['A']}}
  ].entries()) {
    await expect(run(path,metadata,`noop-conflict-${i}`)).rejects.toThrow('INGEST_METADATA_FAILED')
    expect(h.store.blocksOf(id).tags).toEqual(before)
  }
})
it('实际外部包在项目外打包、安装并发现能力；重启回执和停用数据保留',async()=>{
  const build=tempDir('rm-meta-pack-');roots.push(build)
  const root=join(build,'library'),m=new PackageManager(join(build,'user'),PLUGINS.map(p=>p.id)),lib=openLibrary(root)
  for(const id of ['tags','note','source']) {
    cpSync(pluginSource(id),join(build,id),{recursive:true});await packPlugin(join(build,id),join(build,id+'.rmplugin'))
    const ref=m.install(readFileSync(join(build,id+'.rmplugin')));m.grant(root,ref.hash);setBinding(lib,{...ref,enabled:true},PLUGINS)
  }
  lib.close()
  const start=async()=>{const l=openLibrary(root);try{const a=await loadExternalCore(l,PLUGINS,corePlugins,m.begin(root),DISTRIBUTION);const h=new Host(root,a.plugins,()=>{},{library:l,manifest:a.manifest});m.ready(root);return h}catch(e){l.close();throw e}}
  let h=await start()
  try {
    const path=join(build,'input.txt');writeFileSync(path,'packaged metadata')
    const request={operation:'import_files',requestId:'packaged-metadata',args:{files:[{path,metadata}]}}
    const first=await h.api.executeOperation(request),id=(first.result as IngestResult).items[0].id
    expect((await h.api.describeLibrary()).ingestMetadata).toHaveLength(4)
    h.close();h=await start();expect(await h.api.executeOperation(request)).toEqual({...first,replayed:true})
    expect(h.store.blocksOf(id).tags.data.values).toEqual(['阅读','参考'])
    const {readBindings}=await import('../../src/core/external-plugins')
    h.api.setPluginSettings([],readBindings(h.lib).map(p=>({...p,enabled:false})))
    h.close();h=await start();expect((await h.api.describeLibrary()).ingestMetadata).toEqual([])
    expect((await h.api.readContent({id,kind:'note',field:'text'})).text).toBe('  保留缩进\n')
    await expect(h.api.executeOperation({...request,requestId:'disabled-metadata'})).rejects.toThrow('UNAVAILABLE_INGEST_METADATA')
  }finally{if(h.lib.db.open)h.close()}
},60000)
