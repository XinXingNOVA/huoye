import { colorFiltersFlow, colorFiltersResume } from './capture-color-filters'
import '../../src/main/index'
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
import { executeUiCommand } from './capture-command'
const dir = process.env.VISUAL_CHECK_DIR!
const until = async (fn:()=>Promise<unknown>, label:string) => { for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('等待失败：'+label) }
void app.whenReady().then(async()=> {
 await until(async()=>BrowserWindow.getAllWindows().some(w=>libraryOf(w.webContents)), '仓库窗口')
 const win=BrowserWindow.getAllWindows().find(w=>libraryOf(w.webContents))!
 const js=(code:string)=>win.webContents.executeJavaScript(code)
 const call=<K extends keyof CoreApi>(m:K,...a:Parameters<CoreApi[K]>)=>callCore(libraryOf(win.webContents)!.core,m,...a)
 await until(()=>js(`!!document.querySelector('[aria-label="打开命令面板"]')`),'界面')
 const phase=process.env.VISUAL_CHECK_PHASE!
 if(phase==='resume') {
   const ids=JSON.parse(readFileSync(join(dir,'ids.json'),'utf8')) as string[]
   const rows=await call('get',ids)
   assert.equal(rows[0].blocks.rating.data.value,5)
   assert.equal(rows[1].blocks.rating.data.value,4)
   assert.equal(rows[2].blocks.rating,undefined)
   assert.equal(rows[0].blocks['image-filter.geometry'].data.shape,'横图')
   const saved=await call('query',{scope:'all',has:['view']})
   assert.ok(saved.ids.length)
   const rule=(await call('get',saved.ids)).find(v=>v.blocks.view.data.title==='横图精选')!.blocks.view.data.query as Parameters<CoreApi['query']>[0]
   assert.deepEqual((await call('query',rule)).ids,[ids[0]])
   writeFileSync(join(dir,'resume-result.json'),JSON.stringify({ratingsSurviveRestart:true,geometrySurvivesRestart:true,savedView:true,...(process.env.VISUAL_CHECK_PALETTE?{colorSavedView:true}: {})}))
   if (process.env.VISUAL_CHECK_PALETTE) await colorFiltersResume(win,dir)
   app.exit(0);return
 }
 await until(async()=> (await call('plugins')).filter(p=>['rating','image-filter'].includes(p.id)&&p.enabled).length===2,'插件启用')
 const sizes=[[320,160],[160,320],[200,200],[600,100],[100,600]]
 const ids:string[]=[]
 for(const [i,[width,height]] of sizes.entries()) {
   const path=join(dir,`image-${i}.png`)
   await sharp({create:{width,height,channels:3,background:'#5b80c5'}}).png().toFile(path)
   ids.push(...await call('ingest',[{type:'file',path}]))
 }
 await until(async()=> (await call('get',ids)).every(v=>v.blocks['image-filter.geometry']&&v.blocks.thumb),'新图加工')
 assert.deepEqual((await call('get',ids)).map(v=>v.blocks['image-filter.geometry'].data.shape),['横图','竖图','方图','长横图','长竖图'])
 await call('run','rating','set',{ids:ids.slice(0,2),value:4})
 await assert.rejects(call('run','rating','set',{ids:[ids[0],'missing'],value:1}))
 assert.equal((await call('get',[ids[0]]))[0].blocks.rating.data.value,4)
 await call('undo');assert.ok((await call('get',ids)).every(v=>!v.blocks.rating))
 await call('redo')
 const request={operation:'set_rating',requestId:'visual-rating-request',args:{ids:[ids[2]],value:2}}
 assert.equal((await call('executeOperation',request)).replayed,false)
 assert.equal((await call('executeOperation',request)).replayed,true)
 await call('run','rating','set',{ids:[ids[2]],value:null})
 const query={scope:'content' as const,where:[{op:'range' as const,kind:'rating',field:'value',min:4},{op:'eq' as const,kind:'image-filter.geometry',field:'shape',value:'横图'},{op:'range' as const,kind:'image',field:'width',min:300}]}
 assert.deepEqual((await call('query',query)).ids,[ids[0]])
 assert.equal((await call('query',{scope:'content',where:[{op:'empty',kind:'rating',field:'value'}]})).ids.length,3)
 await call('create',{view:{title:'横图精选',query}})
 await executeUiCommand(js,'host.view.all')
 await until(()=>js(`!!document.querySelector('.rm-rating-filters') && !!document.querySelector('.rm-image-filter-pills')`),'筛选面板')
 const click=async(selector:string,text:string)=> { await js(`([...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)})).click()`);await new Promise(r=>setTimeout(r,250)) }
 await click('.rm-rating-filters button','4★及以上')
 await js(`document.querySelector('.rm-image-filter-pills button').nextElementSibling.click()`)
 await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===1`),'组合筛选')
 await click('.rm-rating-filters button','未评分')
 await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===0`),'替换评分条件')
 await click('.rm-rating-filters button','未评分')
 await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===1`),'清除评分条件')
 const widthInput = '.rm-image-filter-range input[aria-label="宽度最小像素"]'
 const setWidth = async (value:string) => js(`(() => { const input=document.querySelector(${JSON.stringify(widthInput)}); input.scrollIntoView({block:'center'}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
 const submitWidth = async () => js(`document.querySelector(${JSON.stringify(widthInput)}).closest('form').requestSubmit()`)
 await setWidth('400');await submitWidth()
 await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===0`),'宽度排除')
 await setWidth('300');await submitWidth()
 await until(()=>js(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===1`),'宽度范围更新')
 await setWidth('');await submitWidth()
 await until(()=>js(`document.querySelector(${JSON.stringify(widthInput)}).closest('form').querySelector('button[type="button"]').disabled`),'清除宽度')
 await js(`document.querySelector('[data-tab-focused="true"] [data-entity-id="${ids[0]}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
 await until(()=>js(`!!document.querySelector('.rm-rating-stars')`),'详情评分')
 await js(`document.querySelector('.rm-rating-stars [aria-label="5 星"]').click()`)
 await until(async()=> (await call('get',[ids[0]]))[0].blocks.rating.data.value===5,'点击星级')
 await until(()=>js(`document.querySelectorAll('.rm-rating-stars .selected').length===5`),'评分界面更新')
 writeFileSync(join(dir,'filters.png'),(await win.webContents.capturePage()).toPNG())
 // 停用保留，再清理各自数据，原件及缩略图不受影响；重启加工历史图片。
 console.log('查询、筛选与评分界面通过')
 const bindings=await call('externalPlugins')
 await call('setPluginSettings',[],bindings.map(b=>({...b,enabled:false})))
 await reloadLibrary(libraryOf(win.webContents)!)
 await until(async()=> !win.webContents.isLoading() && await js(`!!document.querySelector('[aria-label="打开命令面板"]')`), '重载界面')
 await until(async()=> (await call('plugins')).filter(p=>['rating','image-filter'].includes(p.id)&&p.enabled).length===0,'停用')
 assert.equal((await call('get',[ids[0]]))[0].blocks.rating.data.value,5)
 const preview=await call('previewPluginDataCleanup',{pluginId:'image-filter',mode:'all'})
 assert.deepEqual(preview.blocked,[])
 await call('cleanupPluginData',{pluginId:'image-filter',mode:'all',token:preview.token})
 const row=(await call('get',[ids[0]]))[0]
 assert.equal(row.blocks['image-filter.geometry'],undefined);assert.ok(row.blocks.file&&row.blocks.thumb&&row.blocks.rating)
 const ratingPreview=await call('previewPluginDataCleanup',{pluginId:'rating',mode:'all'})
 assert.deepEqual(ratingPreview.blocked,[])
 await call('cleanupPluginData',{pluginId:'rating',mode:'all',token:ratingPreview.token})
 assert.ok((await call('get',ids)).every(v=>!v.blocks.rating && v.blocks.file && v.blocks.thumb))
 await call('setPluginSettings',[],bindings)
 await reloadLibrary(libraryOf(win.webContents)!)
 await until(async()=> !win.webContents.isLoading() && await js(`!!document.querySelector('[aria-label="打开命令面板"]')`), '重载界面')
 await until(async()=> (await call('get',ids)).every(v=>v.blocks['image-filter.geometry']),'重新启用重算')
 await call('run','rating','set',{ids:[ids[0]],value:5})
 await call('run','rating','set',{ids:[ids[1]],value:4})
 assert.deepEqual((await call('query',{scope:'content',has:['rating'],sort:{kind:'rating',field:'value'},dir:'desc'})).ids,[ids[0],ids[1]])
 if (process.env.VISUAL_CHECK_PALETTE) await colorFiltersFlow(win,dir)
 writeFileSync(join(dir,'ids.json'),JSON.stringify(ids))
 writeFileSync(join(dir,'first-result.json'),JSON.stringify({newImageProcessing:true,batchAtomic:true,undoRedo:true,operationReplay:true,queryComposition:true,facetReplacement:true,dimensionControls:true,inspectorRating:true,cleanupIsolated:true,rebuildExisting:true,...(process.env.VISUAL_CHECK_PALETTE?{colorFilters:true,colorDetailClick:true,colorViewSavedFromUi:true,colorCleanupIsolated:true}: {})}))
 app.exit(0)
}).catch(e=>{console.error(e);app.exit(1)})
