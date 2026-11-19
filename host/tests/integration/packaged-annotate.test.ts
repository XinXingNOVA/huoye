import { pluginSource } from '../helpers/plugin-sources'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { packPlugin } from '../../scripts/plugins/pack'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { adoptBundledPlugins, loadExternalCore, readBindings, readDisabled, setBinding } from '../../src/core/external-plugins'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { PLUGINS } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { anchorBlock as v1 } from '../fixtures/legacy-annotate/v1'
import { tempDir } from '../helpers/helpers'

const roots: string[] = [], hosts: Host[] = []
const temp = () => { const dir = tempDir('rm-annotate-'); roots.push(dir); return dir }
let bytes: Buffer, packages: Buffer[], build: string
beforeAll(async () => {
  build = tempDir('rm-annotate-pack-'); packages = []
  for (const id of ['note','annotate']) {
    const source = join(build,id)
    cpSync(pluginSource(id), source, {recursive:true})
    await packPlugin(source, join(build,`${id}.rmplugin`))
    packages.push(readFileSync(join(build,`${id}.rmplugin`)))
    rmSync(source, {recursive:true})
  }
  bytes = packages[1]
}, 60000)
afterAll(() => rmSync(build,{recursive:true,force:true}))
afterEach(() => { hosts.splice(0).forEach(h=>{if(h.lib.db.open) h.close()}); roots.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})) })
const manager = (user = temp()) => { const m = new PackageManager(user,PLUGINS.map(p=>p.id)); m.provisionBundled(packages); return m }
async function start(root: string, m: PackageManager) {
  const lib = openLibrary(root)
  try {
    adoptBundledPlugins(lib,m.bundled(),PLUGINS,DISTRIBUTION)
    const assembly = await loadExternalCore(lib,PLUGINS,corePlugins,m.begin(root),DISTRIBUTION)
    const h = new Host(root,assembly.plugins,()=>{},{library:lib,manifest:assembly.manifest})
    hosts.push(h); m.ready(root); await h.scheduler.idle(); return h
  } catch(e) { if(lib.db.open) lib.close(); throw e }
}
async function seed(root: string, version=2, disabled: string[]=[], registered=false) {
  const plugins = legacyCorePlugins.map(p=>p.id==='annotate' && version===1 ? {...p,migrations:undefined,exportSections:undefined,blocks:p.blocks!.map(k=>k.id==='anchor'?v1:k)} : p)
  const h = new Host(root,plugins,()=>{},{manifest:legacyManifest})
  try {
    h.lib.db.prepare("DELETE FROM main.meta WHERE key='plugin_defaults_pending'").run()
    const [target] = await h.api.ingest([{type:'text',text:'旧摘录的留白与节奏'}])
    const quote = h.api.create({anchor:{target,type:'文本区间',quote:'留白与节奏',prefix:'旧摘录的',suffix:'',offset:4,aspect:2},note:{text:'原有批注'}}) as string
    await h.scheduler.idle(); h.api.setPlugins(disabled)
    if(registered) h.lib.db.prepare("INSERT OR REPLACE INTO main.config(key,value) VALUES('pluginSelection',?)").run(JSON.stringify({version:1,known:legacyManifest.map(p=>p.id)}))
    return {target,quote,records:h.store.get([target,quote]),history:h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()}
  } finally { h.close() }
}
function update(root: string,m: PackageManager,code: string, feature=true) {
  const p=decodePackage(bytes); p.manifest.version='2.0.0'
  if(!feature) p.manifest.coreFeatures=['image-crop-v1']
  p.files.set('core.mjs',Buffer.from(p.files.get('core.mjs')!.toString()+'\n'+code))
  const ref=m.install(encodePackage(p.manifest,p.files)); m.grant(root,ref.hash)
  const lib=openLibrary(root); try {setBinding(lib,{...ref,enabled:true},PLUGINS)} finally {lib.close()}
}
const dataRows=(h:Host)=>h.lib.db.prepare('SELECT entity_id,kind,data,seq FROM main.block ORDER BY entity_id,kind').all()

it.each([1,2].flatMap(version=>[false,true].flatMap(registered=>[[],['annotate']].map(disabled=>({version,registered,disabled})))) )('v$version / 已登记$registered / 停用$disabled：保留身份、内容、写入序号及历史',async({version,registered,disabled})=>{
  const root=temp(),before=await seed(root,version,disabled,registered),m=manager(),h=await start(root,m)
  expect(PLUGINS.some(p=>p.id==='annotate')).toBe(false)
  expect(h.plan.enabled.has('annotate')).toBe(!disabled.length)
  if (!disabled.length) before.records[1].blocks.anchor.ver=3
  expect(h.store.get([before.target,before.quote])).toEqual(before.records)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
  expect(h.lib.db.prepare("SELECT schema_ver FROM main.block WHERE kind='anchor'").pluck().get()).toBe(disabled.length?version:3)
  expect((await h.api.query({search:[{kind:'anchor',field:'quote',text:'留白'}]})).ids).toEqual([before.quote])
  const config=h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
  adoptBundledPlugins(h.lib,m.bundled(),PLUGINS,DISTRIBUTION)
  expect(h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(config)
})

it('从实际包生成新区域裁图、缩略图及色板；文字失配与依附回收可撤销',async()=>{
  const root=temp(),before=await seed(root),m=manager(),h=await start(root,m)
  const source=join(temp(),'新图.jpg')
  await sharp({create:{width:400,height:300,channels:3,background:'#ff0000'}}).jpeg().toFile(source)
  const [image]=await h.api.ingest([{type:'file',path:source}]); await h.scheduler.idle()
  const local=h.api.create({anchor:{target:image,type:'图片区域',x:0,y:0,w:.25,h:.5,aspect:2/3}}) as string
  await h.scheduler.idle()
  const blocks=h.store.blocksOf(local),path=String(blocks.still.data.path)
  expect(path).toBe(`cache/locals/${local}.jpg`)
  expect(await sharp(join(root,path)).metadata()).toMatchObject({width:100,height:150})
  expect(blocks.thumb).toBeDefined(); expect(String((blocks.palette.data.colors as string[])[0])).toMatch(/^#f/)
  expect(readFileSync(h.lib.files.readable(String(h.store.blocksOf(image).file.data.path)))).toEqual(readFileSync(source))
  h.api.put(before.target,'text',{content:'改写正文'}); await h.scheduler.idle()
  expect(h.store.blocksOf(before.quote).place.data.found).toBe(false)
  h.api.undo(); await h.scheduler.idle(); expect(h.store.blocksOf(before.quote).place.data.found).toBe(true)
  h.api.trash([before.target]); expect(h.store.isTrashed(before.quote)).toBe(true)
  h.api.undo(); expect(h.store.isTrashed(before.quote)).toBe(false)
  const pack=decodePackage(bytes)
  expect(pack.files.get('core.mjs')!.toString()).not.toMatch(/from ["']sharp["']/)
  expect(pack.files.get('ui.css')!.toString()).toContain('.region-layer')
  expect(pack.files.get('ui.css')!.toString()).toContain('.pdf-quote-tools')
})

it('停用、卸载、重启和重新启用保留摘录，未装包的旧 v1 也可只读打开',async()=>{
  const root=temp(),before=await seed(root,1),user=temp(),m=manager(user)
  before.records[1].blocks.anchor.ver=3
  let h=await start(root,m),ref=readBindings(h.lib).find(p=>p.manifest.id==='annotate')!
  h.api.setPluginSettings(readDisabled(h.lib),[{...ref,enabled:false}]);h.close();m.uninstall(ref.hash)
  const restarted=manager(user);h=await start(root,restarted)
  expect(restarted.list().some(p=>p.manifest.id==='annotate')).toBe(false)
  expect(h.reg.kind('anchor')?.dormant).toBe(true)
  expect(h.store.get([before.target,before.quote])).toEqual(before.records)
  expect(()=>h.api.patch(before.quote,'anchor',{quote:'变更'})).toThrow('没有启用')
  restarted.install(bytes);h.close();h=await start(root,restarted)
  expect(h.plan.enabled.has('annotate')).toBe(false)
  restarted.grant(root,ref.hash);h.api.setPluginSettings(readDisabled(h.lib),[{...ref,enabled:true}]);h.close();h=await start(root,restarted)
  expect(h.plan.enabled.has('annotate')).toBe(true)
  h.api.put(before.quote,'note',{text:'重新编辑'});h.api.undo()
  expect(h.store.blocksOf(before.quote).note.data.text).toBe('原有批注')
})

it.each([
  ['删字段','delete annotatePlugin.blocks[0].fields.quote',true],
  ['改引用','annotatePlugin.blocks[0].fields.target.ref="link"',true],
  ['改类型','annotatePlugin.blocks[0].fields.offset.type="text"',true],
  ['缺历史','delete annotatePlugin.compatibleSchemas',true],
  ['缺能力声明','',false],
  ['重写数据','annotatePlugin.blocks[0].validate=data=>{data.quote="篡改"}',true]
] as const)('不兼容包 %s 被停用，旧定义、数据及历史原样保留',async(_label,code,feature)=>{
  const root=temp(),before=await seed(root,1),m=manager()
  const lib=openLibrary(root),snapshot=lib.db.prepare("SELECT * FROM main.kind_def WHERE id='anchor'").all();lib.close()
  update(root,m,code,feature);const h=await start(root,m)
  expect(h.plan.enabled.has('annotate')).toBe(false)
  expect(h.reg.kind('anchor')?.dormant).toBe(true)
  expect(h.store.get([before.target,before.quote])).toEqual(before.records)
  expect(h.lib.db.prepare("SELECT * FROM main.kind_def WHERE id='anchor'").all()).toEqual(snapshot)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
})

it('结构接续发生写入错误时，版本、快照和包契约一起回滚',async()=>{
  const root=temp();await seed(root,1);const m=manager(),lib=openLibrary(root)
  adoptBundledPlugins(lib,m.bundled(),PLUGINS,DISTRIBUTION)
  const assembly=await loadExternalCore(lib,PLUGINS,corePlugins,m.begin(root),DISTRIBUTION)
  const before=['block','kind_def','config','block_history'].map(t=>lib.db.prepare(`SELECT * FROM main.${t}`).all())
  lib.db.exec("CREATE TRIGGER reject_version BEFORE UPDATE OF schema_ver ON block BEGIN SELECT RAISE(ABORT,'模拟磁盘写入失败'); END")
  expect(()=>new Host(root,assembly.plugins,()=>{},{library:lib,manifest:assembly.manifest})).toThrow('模拟磁盘写入失败')
  expect(lib.db.open).toBe(false)
  // Host 已释放失败装配的库；重新打开后核验持久回滚结果，不依赖泄漏的连接。
  const reopened=openLibrary(root)
  try { expect(['block','kind_def','config','block_history'].map(t=>reopened.db.prepare(`SELECT * FROM main.${t}`).all())).toEqual(before) }
  finally { reopened.close() }
})

it('修复旧版 identity migration 遗留的 schema_ver，重开不重复改数据',async()=>{
  const root=temp(),before=await seed(root),m=manager(),lib=openLibrary(root)
  lib.db.prepare("UPDATE main.block SET schema_ver=1 WHERE kind='anchor'").run();lib.close()
  let h=await start(root,m);const rows=dataRows(h);h.close();h=await start(root,m)
  expect(dataRows(h)).toEqual(rows)
  before.records[1].blocks.anchor.ver=3
  expect(h.store.get([before.target,before.quote])).toEqual(before.records)
})

// 只在显式临时路径生成冻结旧库，供真实 Electron 使用。
it.skipIf(!process.env.ANNOTATE_LEGACY_DIR)('准备 Electron v1 旧摘录样本',async()=>{
  const dir=resolve(process.env.ANNOTATE_LEGACY_DIR!)
  mkdirSync(dir,{recursive:true})
  const fixture=await seed(join(dir,'library'),1,[],true)
  fixture.records[1].blocks.anchor.ver=3
  await seed(join(dir,'disabled-library'),1,['annotate'],true)
  writeFileSync(join(dir,'legacy.json'),JSON.stringify(fixture))
})

it('已升级结构不能降回 v1，包契约与旧记录继续保留',async()=>{
  const root=temp();await seed(root,1);const m=manager();let h=await start(root,m)
  const rows=dataRows(h),contract=h.lib.db.prepare("SELECT value FROM main.config WHERE key='externalSchema:annotate'").pluck().get();h.close()
  update(root,m,`annotatePlugin.blocks[0]=${JSON.stringify(v1)};annotatePlugin.compatibleSchemas=[];annotatePlugin.exportSections=[]`)
  h=await start(root,m)
  expect(h.plan.enabled.has('annotate')).toBe(false)
  expect(dataRows(h)).toEqual(rows)
  expect(h.lib.db.prepare("SELECT value FROM main.config WHERE key='externalSchema:annotate'").pluck().get()).toBe(contract)
})
it.each(['unknown-version','deleted-history'])('预检拒绝未声明版本或不可重放历史：%s',async(mode)=>{
  const root=temp(),before=await seed(root,1),m=manager(),lib=openLibrary(root)
  if(mode==='unknown-version')lib.db.prepare("UPDATE main.block SET schema_ver=99 WHERE kind='anchor'").run()
  else {
    lib.db.prepare("DELETE FROM main.block WHERE kind='anchor'").run()
    lib.db.prepare("UPDATE main.block_history SET new_data=? WHERE kind='anchor'").run(JSON.stringify({...before.records[1].blocks.anchor.data,offset:'无法保留的旧值'}))
  }
  const rows=lib.db.prepare('SELECT * FROM main.block').all();lib.close()
  const h=await start(root,m)
  expect(h.plan.enabled.has('annotate')).toBe(false)
  expect(h.lib.db.prepare('SELECT * FROM main.block').all()).toEqual(rows)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history').all()).toEqual([])
})

it('通用摘录与旧记录共存；原文变化、撤销、依附回收和未知来源定位均保留数据',async()=>{
  const root=temp(),before=await seed(root),m=manager(),h=await start(root,m)
  const locator={provider:'text.quote',version:1,data:{prefix:'旧摘录的',suffix:'',offset:4}}
  const quote=h.api.create({anchor:{target:before.target,type:'内容摘录',quote:'留白与节奏',locator,aspect:2},note:{text:'新批注'}}) as string
  await h.scheduler.idle();expect(h.store.blocksOf(quote).place.data.found).toBe(true)
  h.api.put(before.target,'text',{content:'已经改写'});await h.scheduler.idle();expect(h.store.blocksOf(quote).place.data.found).toBe(false)
  h.api.undo();await h.scheduler.idle();expect(h.store.blocksOf(quote).place.data.found).toBe(true)
  h.api.trash([before.target]);expect(h.store.isTrashed(quote)).toBe(true);expect(h.store.isTrashed(before.quote)).toBe(true)
  h.api.undo();expect(h.store.isTrashed(quote)).toBe(false)
  expect(h.store.blocksOf(quote).anchor.data.locator).toEqual(locator)
  const future=h.api.create({anchor:{target:before.target,type:'内容摘录',quote:'未来来源摘录',locator:{provider:'future.document',version:7,data:{section:'one'}}}}) as string
  expect((await h.api.readContent({id:future,kind:'anchor',field:'quote'})).text).toBe('未来来源摘录')
  h.api.setPluginSettings(readDisabled(h.lib),[{...readBindings(h.lib).find(p=>p.manifest.id==='annotate')!,enabled:false}]);h.close()
  const restarted=await start(root,m)
  expect(restarted.store.blocksOf(quote).note.data.text).toBe('新批注')
  expect(restarted.store.blocksOf(future).anchor.data.locator).toEqual({provider:'future.document',version:7,data:{section:'one'}})
})
