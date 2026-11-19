import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
const kind = 'palette.families'
const until = async (fn:()=>Promise<unknown>,label:string) => { for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error(label) }
const client = (win:BrowserWindow) => <K extends keyof CoreApi>(method:K,...args:Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core,method,...args)
export async function colorFiltersFlow(win:BrowserWindow,dir:string) {
  const call=client(win), js=(s:string)=>win.webContents.executeJavaScript(s)
  const ids:string[]=[]
  for(const [i,color] of ['#ff0000','#0000ff','mixed'].entries()) {
    const path=join(dir,`color-${i}.png`)
    const source=sharp({create:{width:100,height:50,channels:3,background:color==='mixed'?'#ff0000':color}})
    if(color==='mixed') source.composite([{input:await sharp({create:{width:50,height:50,channels:3,background:'#0000ff'}}).png().toBuffer(),left:50,top:0}])
    await source.png().toFile(path)
    ids.push(...await call('ingest',[{type:'file',path}]))
  }
  await until(async()=> (await call('get',ids)).every(v=>v.blocks[kind]),'色系加工')
  assert.deepEqual((await call('get',ids)).map(v=>v.blocks[kind].data.values),[['红色'],['蓝色'],['红色','蓝色']])
  await call('run','rating','set',{ids,value:4})
  const query={scope:'content' as const,where:[{op:'range' as const,kind:'rating',field:'value',min:4},{op:'range' as const,kind:'image',field:'width',max:150},{op:'eq' as const,kind:'image-filter.geometry',field:'shape',value:'横图'}]}
  assert.deepEqual((await call('facet',kind,'values',{query})).map(x=>[x.value,x.count]).sort(),[['红色',2],['蓝色',2]].sort())
  const selected=async()=>js(`Array.from(document.querySelectorAll('.rm-palette-family[aria-pressed="true"]')).map(b=>b.dataset.family)`)
  const pick=async(color:string,ctrl=false)=>js(`document.querySelector('.rm-palette-family[data-family="${color}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:${ctrl}}))`)
  await until(()=>js(`!!document.querySelector('.rm-palette-family')`),'颜色筛选入口')
  await pick('红色')
  await until(async()=>JSON.stringify(await selected())==='["红色"]','红色选择')
  await pick('蓝色',true)
  await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===1`),'同时包含红蓝')
  assert.deepEqual(await selected(),['红色','蓝色'])
  await pick('蓝色')
  await until(async()=>JSON.stringify(await selected())==='["蓝色"]','蓝色独占选择')
  await until(()=>js(`!!document.querySelector('[data-entity-id="${ids[2]}"]')`),'混色素材')
  await js(`document.querySelector('[data-tab-focused="true"] [data-entity-id="${ids[2]}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(()=>js(`!!document.querySelector('.rm-palette-swatch[data-color-family="红色"]')`),'详情色板')
  await js(`document.querySelector('.rm-palette-swatch[data-color-family="红色"]').click()`)
  await until(async()=>JSON.stringify(await selected())==='["红色"]','详情切换颜色')
  // 在真实界面叠加评分、尺寸，再通过保存视图弹窗保存组合。
  await js(`Array.from(document.querySelectorAll('.rm-rating-filters button')).find(b=>b.textContent==='4★及以上').click()`)
  await js(`(() => {const input=document.querySelector('[aria-label="宽度最大像素"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'150');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await js(`document.querySelector('[aria-label="宽度最大像素"]').closest('form').requestSubmit()`)
  await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===2`),'色系评分尺寸组合')
  const savedQuery={...query,where:[...query.where,{op:'eq' as const,kind,field:'values',value:'红色'}]}
  await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存为视图…').click()`)
  await until(()=>js(`!!document.querySelector('[aria-label="视图名称"]')`),'保存视图弹窗')
  await js(`(() => {const input=document.querySelector('[aria-label="视图名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'红色精选');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存视图').click()`)
  const findSaved=async()=> (await call('get',(await call('query',{scope:'all',has:['view']})).ids)).find(v=>v.blocks.view.data.title==='红色精选')
  await until(async()=>!!await findSaved(),'保存色系组合')
  const saved=(await findSaved())!, savedId=saved.id
  const actualQuery=saved.blocks.view.data.query as typeof savedQuery
  for(const condition of savedQuery.where) assert.ok(actualQuery.where.some(c=>JSON.stringify(c)===JSON.stringify(condition)),JSON.stringify(actualQuery))
  assert.deepEqual(new Set((await call('query',savedQuery)).ids),new Set([ids[0],ids[2]]))
  await until(()=>js(`!document.querySelector('[aria-label="视图名称"]')`),'保存后关闭弹窗')
  writeFileSync(join(dir,'colors.png'),(await win.webContents.capturePage()).toPNG())
  const bindings=await call('externalPlugins')
  const before=(await call('get',ids))[0].blocks
  await call('setPluginSettings',[],bindings.map(b=>b.manifest.id==='palette'?{...b,enabled:false}:b))
  await reloadLibrary(libraryOf(win.webContents)!)
  await until(async()=>!win.webContents.isLoading()&&await js(`!!document.querySelector('[aria-label="打开命令面板"]')`),'停用重载')
  assert.deepEqual((await call('get',[ids[0]]))[0].blocks[kind].data,before[kind].data)
  const preview=await call('previewPluginDataCleanup',{pluginId:'palette',mode:'all'})
  assert.deepEqual(preview.blocked,[])
  await call('cleanupPluginData',{pluginId:'palette',mode:'all',token:preview.token})
  const cleared=(await call('get',[ids[0]]))[0].blocks
  assert.equal(cleared[kind],undefined);assert.equal(cleared.palette,undefined)
  for(const k of ['file','thumb','rating','image-filter.geometry']) assert.equal(cleared[k].seq,before[k].seq)
  await call('setPluginSettings',[],bindings)
  await reloadLibrary(libraryOf(win.webContents)!)
  await until(async()=>!win.webContents.isLoading()&&await js(`!!document.querySelector('[aria-label="打开命令面板"]')`),'启用重载')
  await until(async()=> (await call('get',ids)).every(v=>v.blocks[kind]),'色系重新加工')
  assert.deepEqual(new Set((await call('query',savedQuery)).ids),new Set([ids[0],ids[2]]))
  writeFileSync(join(dir,'color-state.json'),JSON.stringify({ids,savedId}))
  console.log('色系：真实提取、单选/叠加、详情点击、组合查询、停用清理与补算通过')
}
export async function colorFiltersResume(win:BrowserWindow,dir:string) {
  const call=client(win),{ids,savedId}=JSON.parse(readFileSync(join(dir,'color-state.json'),'utf8'))
  const query=(await call('get',[savedId]))[0].blocks.view.data.query as Parameters<CoreApi['query']>[0]
  assert.deepEqual(new Set((await call('query',query)).ids),new Set([ids[0],ids[2]]))
  console.log('色系保存视图在新进程恢复通过')
}
