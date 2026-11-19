import { packageTaskBlockers } from '../../src/plugin-packages/task-references'
import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { PackageUpdates, type UpdateEnvironment } from '../../src/plugin-packages/updates'
import { openLibrary, type Library } from '../../src/core/library'
import { loadExternalCore, readBindings, setBinding } from '../../src/core/external-plugins'
import { updateLibraryPackage } from '../../src/core/package-update'
import { Host } from '../../src/core/host'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import type { PackageManifest, PackageRef } from '../../src/shared/external-plugins'
import type { UpdateLibrary } from '../../src/shared/plugin-updates'
const cleanups: (()=>void)[] = []
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn() })
const manifest = (version: string): PackageManifest => ({ formatVersion:1, apiVersion:1, id:'update-demo', title:'更新测试', description:'', author:'测试', version, requires:[], optional:[], entries:{core:'core.mjs'}, styles:[] })
const pack = (version: string, incompatible = false) => encodePackage(manifest(version), new Map([['core.mjs', Buffer.from(`export const blocks=[{id:'update-demo.note',plugin:'update-demo',title:'笔记',version:1,fields:{text:{title:'正文',type:'${incompatible ? 'number' : 'text'}'}}}]; export const plugin={id:'update-demo',version:1,blocks};`)]]))
async function setup() {
  const dir=mkdtempSync(join(tmpdir(),'rm-update-')); cleanups.push(()=>rmSync(dir,{recursive:true,force:true}))
  const manager=new PackageManager(join(dir,'app'),[])
  manager.provisionBundled([pack('1.0.0')])
  const old=manager.bundled()[0]
  const libraries: Library[]=[], ids:string[]=[]
  for (let i=0;i<2;i++) {
    const lib=openLibrary(join(dir,`lib-${i}`)); libraries.push(lib)
    manager.grant(lib.root,old.hash); setBinding(lib,{...old,enabled:true},PLUGINS)
    const loaded=await loadExternalCore(lib,PLUGINS,corePlugins,manager.begin(lib.root),DISTRIBUTION); manager.ready(lib.root)
    const host=new Host(lib.root,loaded.plugins,()=>{}, {library:lib,manifest:loaded.manifest}); cleanups.push(()=>host.close())
    const [id]=await host.api.ingest([{type:'text',text:'保留正文'}]); ids.push(id)
    host.api.put(id,'update-demo.note',{text:'保留插件数据'})
    if(i===1)setBinding(lib,{...old,enabled:false},PLUGINS)
  }
  const scan=async(previous:PackageRef)=>({libraries:libraries.flatMap(lib=>{
    const binding=readBindings(lib).find(b=>b.hash===previous.hash)
    return binding?[{root:lib.root,id:lib.id,name:lib.root,binding}]:[]
  }),blockers:[] as string[]})
  const apply=async(l:UpdateLibrary,previous:PackageRef,next:PackageRef,action:'check'|'replace')=> updateLibraryPackage(libraries.find(lib=>lib.id===l.id)!,{
    type:'package-update',root:l.root,libraryId:l.id,previous,next,binding:l.binding,action,
    packages:manager.list().map(p=>({...p,directory:manager.directory(p.hash)}))
  })
  const env:UpdateEnvironment={scan,prepare:async()=>{},check:(...args)=>apply(...args,'check'),replace:(...args)=>apply(...args,'replace'),reload:async()=>{},resume:()=>{}}
  const create=()=>new PackageUpdates(join(dir,'updates'),manager,env)
  return {dir,manager,old,libraries,ids,env,create}
}
it('跨库替换保留启停与数据；部分提交中断后按原任务幂等接续，成功移除旧包',async()=>{
  const s=await setup(), updates=s.create(), preview=await updates.preview(1,s.old.hash,pack('1.1.0'))
  expect(preview.libraries.map(l=>l.binding.enabled)).toEqual([true,false])
  const replace=s.env.replace; let fail=true
  s.env.replace=async(l,...args)=>{if(fail&&l.id===s.libraries[1].id)throw Error('模拟第二库写入失败');await replace(l,...args)}
  const stopped=await updates.start(1,preview.token)
  expect(stopped.phase).toBe('switching');expect(stopped.error).toContain('第二库')
  expect(existsSync(s.manager.directory(s.old.hash))).toBe(true)
  expect(readBindings(s.libraries[0])[0].hash).toBe(preview.next.hash)
  expect(readBindings(s.libraries[1])[0].hash).toBe(s.old.hash)
  fail=false
  const result=await s.create().run(preview.token)
  expect(result.phase).toBe('complete');expect(s.manager.list().map(p=>p.hash)).toEqual([preview.next.hash])
  expect(existsSync(s.manager.directory(s.old.hash))).toBe(false)
  for(const [i,lib] of s.libraries.entries()) {
    expect(readBindings(lib)[0]).toMatchObject({hash:preview.next.hash,enabled:i===0})
    expect(JSON.parse(lib.db.prepare("SELECT data FROM block WHERE entity_id=? AND kind='update-demo.note'").pluck().get(s.ids[i]) as string)).toEqual({text:'保留插件数据'})
  }
})
it('不兼容持久定义在任何绑定变化前拒绝；原数据与旧包保持，可取消',async()=>{
  const s=await setup(), updates=s.create(), p=await updates.preview(1,s.old.hash,pack('2.0.0',true))
  const result=await updates.start(1,p.token)
  expect(result.phase).toBe('prepared');expect(result.error).toContain('持久数据结构')
  expect(s.libraries.every(lib=>readBindings(lib)[0].hash===s.old.hash)).toBe(true)
  updates.cancel(p.token);expect(updates.read()).toBeUndefined()
})
it('固定引用、预览后选择变化和错误包不允许静默替换',async()=>{
  const s=await setup(), updates=s.create()
  await expect(updates.preview(1,s.old.hash,pack('1.0.0'))).rejects.toThrow('更高版本')
  s.env.scan=async()=>({libraries:[],blockers:['未完成建库任务引用旧包']})
  const p=await updates.preview(1,s.old.hash,pack('1.1.0'))
  expect(p.blockers).toEqual(['未完成建库任务引用旧包'])
  await expect(updates.start(1,p.token)).rejects.toThrow('未完成建库任务')
  expect(updates.read()).toBeUndefined()
  s.env.scan=async()=>({libraries:[],blockers:[]})
  const p2=await updates.preview(1,s.old.hash,pack('1.1.0'))
  s.env.scan=async()=>({libraries:[{root:s.libraries[0].root,id:s.libraries[0].id,name:'库',binding:readBindings(s.libraries[0])[0]}],blockers:[]})
  await expect(updates.start(1,p2.token)).rejects.toThrow('受影响仓库已变化')
})
it('旧包登记已移除后清理中断，重启继续完成，不重复切换仓库',async()=>{
  const s=await setup(), updates=s.create(), p=await updates.preview(1,s.old.hash,pack('1.1.0'))
  const finish=s.manager.finishReplacement.bind(s.manager);let fail=true
  s.manager.finishReplacement=(...args)=>{finish(...args);if(fail)throw Error('模拟清理后退出')}
  expect((await updates.start(1,p.token)).phase).toBe('removing')
  fail=false
  expect((await s.create().run(p.token)).phase).toBe('complete')
  const reopened=new PackageManager(join(s.dir,'app'),[])
  reopened.provisionBundled([pack('1.0.0')])
  expect(reopened.bundled()[0].hash).toBe(p.next.hash)
  expect(reopened.list().map(r=>r.hash)).toEqual([p.next.hash])
  expect(reopened.automationAllowed(p.next.hash)).toBe(false)
  const fresh = join(s.dir, 'fresh')
  reopened.begin(fresh)
  expect(reopened.authorization(fresh, p.next.hash)).toBe('approval-required')
})

it('新版运行失败可明确结束任务，保留两版和已提交选择，允许安装修正版',async()=>{
  const s=await setup(), updates=s.create(), p=await updates.preview(1,s.old.hash,pack('1.1.0'))
  s.env.reload=async()=>{throw Error('新版界面运行失败')}
  expect((await updates.start(1,p.token)).phase).toBe('switching')
  updates.cancel(p.token)
  expect(updates.read()).toBeUndefined()
  expect(s.manager.list()).toHaveLength(2)
  expect(readBindings(s.libraries[0])[0].hash).toBe(p.next.hash)
  expect(readBindings(s.libraries[1])[0].hash).toBe(s.old.hash)
  await expect(updates.preview(1,p.next.hash,pack('1.2.0'))).resolves.toMatchObject({next:{manifest:{version:'1.2.0'}}})
})


it('固定任务引用只阻止未完成任务，保留的完成／取消回执不锁住包更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-task-pins-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const hash = 'a'.repeat(64)
  const save = (folder: string, state?: string) => { mkdirSync(join(dir, folder), { recursive: true }); writeFileSync(join(dir, folder, 'job.json'), JSON.stringify({ state, selection: { external: [{ hash }] } })) }
  save('library-creations', 'completed'); save('mcp/management/configurations', 'cancelled')
  expect(packageTaskBlockers(dir, hash, ['mcp'])).toEqual([])
  save('library-creations'); save('mcp/management/configurations', 'pending'); save('mcp/management/installations/request-1', 'pending')
  expect(packageTaskBlockers(dir, hash, ['mcp'])).toHaveLength(3)
})
