import '../../src/main/index'
import { app, BrowserWindow, dialog } from 'electron'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { launcherWindow } from '../../src/main/launcher'
import { openLibrary, openLibraries, type OpenLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'
import { callCore } from '../../src/main/core-client'
import { settingsScript, findSettingsSurface } from './settings-surface'
import { executeUiCommand } from './capture-command'
import { decodeSuite } from '../../src/plugin-packages/suites'
import type { CoreApi } from '../../src/shared/rpc'
const dir=realpathSync(process.env.VISUAL_SUITE_DIR!), phase=process.env.VISUAL_SUITE_PHASE!
const suite=decodeSuite(readFileSync(process.env.VISUAL_SUITE_FILE!)), scheme='suite:visual-library:browse'
const pause=()=>new Promise(r=>setTimeout(r,100))
async function until(check:()=>unknown|Promise<unknown>,label:string) {
 for(let n=0;n<400;n++){if(await check())return;await pause()}
 throw Error('等待失败：'+label)
}
const script=(win:BrowserWindow)=>(code:string)=>win.webContents.executeJavaScript(code)
const core=(lib:OpenLibrary)=><K extends keyof CoreApi>(m:K,...args:Parameters<CoreApi[K]>)=>callCore(lib.core,m,...args)
async function click(js:(s:string)=>Promise<any>,selector:string,label:string) {
 const ok=await js(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!e||e.disabled)return false;e.click();return true})()`)
 assert.ok(ok,'按钮：'+label);await pause()
}
async function ready(lib:OpenLibrary) {
 const js=script(lib.win)
 await until(()=>js(`!!document.querySelector('[aria-label="打开命令面板"]')`),'主界面')
 await until(async()=>suite.manifest.packages.every(p=>(lib.packages.some(q=>q.manifest.id===p.id))) && !(lib.reloading),'加载套件包')
 await until(async()=>{
   const rows=await core(lib)('plugins')
   const bad=rows.filter(p=>suite.manifest.packages.some(q=>q.id===p.id)&&!p.enabled)
   if(bad.length)throw Error(JSON.stringify(bad))
   return suite.manifest.packages.every(p=>rows.some(q=>q.id===p.id&&q.enabled)) && !await js('window.bridge.pluginPresets.pending()')
 },'启用及布局接续')
 await until(()=>js(`!!document.querySelector('.rm-palette-families') && !!document.querySelector('.rm-rating-filters') && !!document.querySelector('.rm-image-filter-pills')`),'智能筛选')
}
async function workspace(lib:OpenLibrary) {
 const js=script(lib.win)
 await until(async()=>!!(await js(`window.bridge.loadWorkspace(${JSON.stringify(lib.id)})`))?.presetApplication,'工作台保存')
 return js(`window.bridge.loadWorkspace(${JSON.stringify(lib.id)})`)
}
async function checkLayout(lib:OpenLibrary) {
 const ws=await workspace(lib)
 assert.equal(ws.editors.root.type,'group');assert.equal(ws.panels.sidebar,true);assert.equal(ws.panels.inspector,true)
 assert(ws.tabs.some((t:any)=>t.type==='collection'))
 assert.equal(ws.sidebars.containers.filter((c:any)=>!c.closed).length,3)
 return ws
}
const appNavigation = ['外观与主题', '界面语言 / Language', 'AI 接入 · MCP', '套件与插件包', '文件空间与外部应用']
async function applyFromSettings(lib: OpenLibrary, compareId?: string) {
 const js = script(lib.win), s = (code: string) => settingsScript(lib.win, code)
 lib.win.webContents.send('menu:command', 'settings')
 await until(() => findSettingsSurface(lib.win), '设置')
 await until(() => s(`!!document.querySelector('.settings-nav-scroll')`), '设置导航')
 assert.deepEqual(await s(`[...document.querySelectorAll('.settings-library-nav button')].map(b=>b.textContent)`), ['导入与空间', '功能与方案', '本库外观', '数据与维护'])
 assert.deepEqual(await s(`[...document.querySelectorAll('.application-settings-nav button')].map(b=>b.textContent)`), appNavigation)
 await click(s, '.settings-nav-scroll button', '套件与插件包')
 const suiteButton = `.plugin-suites [data-preview-preset="${scheme}"]`
 await until(() => s(`!!document.querySelector('${suiteButton}')?.checkVisibility()`), '已登记的视觉素材库套件')
 await s(`document.querySelector('${suiteButton}').closest('.plugin-suite-card').querySelector('.plugin-suite-head button').click()`)
 const members = decodeSuite(readFileSync(process.env.VISUAL_SUITE_FILE!)).manifest.packages.map(p => p.id).sort()
 assert.deepEqual(await s(`Array.from(document.querySelectorAll('.application-settings .plugin-tiles [data-package-id]'), e=>e.dataset.packageId).sort()`), members)
 await s(`document.querySelector('${suiteButton}').click()`)
 const preview = (id: string) => `[data-preset-preview="${id}"]`
 await until(() => s(`!!document.querySelector('${preview(scheme)}')?.checkVisibility()`), '从已安装套件直达方案')
 const color = `${preview(scheme)} select[data-plugin-version="palette"]`
 const chosen = JSON.parse(readFileSync(join(dir,'local-palette.json'),'utf8')).hash
 if (compareId) {
   assert(await s(`document.querySelector('${preview(scheme)} [role="alert"]').innerText.includes('所选构建未安装')`))
   assert(await s(`document.querySelector('${preview(scheme)} button.primary').disabled`))
   assert.equal(await s(`document.querySelector('${color}').value`), '', '缺少已绑定构建时须显式选择')
   assert.deepEqual(await s(`[...document.querySelectorAll('${preview(scheme)} select')].filter(e=>e.checkVisibility()).map(e=>e.dataset.pluginVersion)`), ['palette'])
   assert(await s(`document.querySelector('${preview(scheme)} .plugin-presets-changes summary').innerText.includes('启用')`))
   assert.equal(await s(`document.querySelector('${preview(scheme)} details[open]') !== null`), false)
   await s(`document.querySelector('[data-preset-id="${compareId}"]').click()`)
   await until(() => s(`!!document.querySelector('${preview(compareId)}')?.checkVisibility()`), '另一份方案的差异')
   assert(await s(`document.querySelector('${preview(compareId)}').innerText.includes('没有启停变化')`))
   assert.equal(await s(`!!document.querySelector('.settings-dirty-dot')`), false, '比较方案不能改动勾选')
   await s(`document.querySelector('[data-preset-id="${scheme}"]').click()`)
   await until(() => s(`!!document.querySelector('${preview(scheme)}')`), '返回视觉方案')
   writeFileSync(join(dir, 'settings-presets.png'), (await findSettingsSurface(lib.win)!.webContents.capturePage()).toPNG())
   await s(`(() => {const e=document.querySelector('${color}');e.value=${JSON.stringify(chosen)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
   await until(() => s(`!!document.querySelector('${preview(scheme)} button.primary:enabled') && !document.querySelector('${preview(scheme)} [role="alert"]')`), '选择可用的色板后解除阻断')
   const notes = `${preview(scheme)} .plugin-presets-versions`
   assert.equal(await s(`document.querySelector('${notes}').open`), false)
   await pause()
   writeFileSync(join(dir, 'preset-resolved.png'), (await findSettingsSurface(lib.win)!.webContents.capturePage()).toPNG())
   await s(`document.querySelector('${notes} summary').click()`)
   assert(await s(`document.querySelector('${notes}').innerText.includes('安装包构建不同')`))
   await s(`document.querySelector('${notes} summary').click()`)
 }
 assert.equal(await s(`!!document.querySelector('${color}')`), false, '仅有一个可用且已选的版本无需再选')
 await click(s, `${preview(scheme)} button`, '采用此方案')
 await click(s, '.settings-subnav button', '启停功能')
 const audio = '[data-plugin-id="audio"] input'
 assert.ok(await s(`document.querySelector('${audio}').checked && document.querySelector('${audio}').checkVisibility()`))
 await s(`document.querySelector('${audio}').click()`)
 if (compareId) {
   const plugins = await core(lib)('plugins')
   assert.ok(plugins.find(p => p.id === 'audio')?.enabled, '手动调整尚未写入')
   assert.ok(!plugins.find(p => p.id === 'rating')?.enabled, '方案尚未写入')
 }
 await until(()=>s(`!![...document.querySelectorAll('.settings-foot button')].find(b=>!b.disabled&&/^应用/.test(b.textContent.trim()))`),'统一应用')
 const previousCore=lib.core
 const reloadExpected=await s(`[...document.querySelectorAll('.settings-foot button')].some(b=>!b.disabled&&b.textContent.includes('重新加载'))`)
 let reloadCount = 0
 const workbenchUrl = lib.win.webContents.getURL()
 // 重载会先经过 about:blank，只统计工作台本身的加载。
 const countReload = () => { if (lib.win.webContents.getURL() === workbenchUrl) reloadCount++ }
 lib.win.webContents.on('did-finish-load', countReload)
 await s(`[...document.querySelectorAll('.settings-foot button')].find(b=>!b.disabled&&/^应用/.test(b.textContent.trim())).click()`)
 assert.equal(reloadExpected, !!compareId)
 if(reloadExpected) await until(()=>lib.core!==previousCore,'新核心已启动')
 else await until(()=>s(`!document.querySelector('.settings-foot.is-dirty')`),'免重载应用结束')
 await until(async()=>!lib.reloading && !lib.win.webContents.isLoading() && await js(`!!document.querySelector('[aria-label="打开命令面板"]')`),'应用完成')
 await until(()=>js('window.bridge.pluginPresets.pending().then(p=>!p)'),'配套布局完成')
 await until(() => !!findSettingsSurface(lib.win) && s(`!!document.querySelector('.settings-subnav [aria-pressed="true"]')`), '恢复原设置子页')
 assert.equal(await s(`document.querySelector('[role="dialog"] h1').textContent`), '功能与方案')
 assert.equal(await s(`document.querySelector('.settings-subnav [aria-pressed="true"]').textContent`), '启停功能')
 assert.equal(await s(`document.querySelector('${audio}').checked`), false)
 assert.equal((await core(lib)('plugins')).find(p => p.id === 'audio')?.enabled, false)
 assert.equal((await js('window.bridge.pluginPresets.current()')).selection.external.find((p: { id: string }) => p.id === 'palette')?.hash, chosen)
 if (compareId) writeFileSync(join(dir, 'settings-after-reload.png'), (await findSettingsSurface(lib.win)!.webContents.capturePage()).toPNG())
 lib.win.webContents.off('did-finish-load', countReload)
 assert.equal(reloadCount, reloadExpected ? 1 : 0, '一次提交的仓库窗口重载次数')
 findSettingsSurface(lib.win)?.close()
 await until(()=>!findSettingsSurface(lib.win),'设置窗口关闭')
 await until(()=>js(`!document.querySelector('.settings-modal')`),'设置浮层移除')
}
void app.whenReady().then(async()=>{
 if(phase==='resume') {
   const saved=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'))
   for(const name of ['视觉新库','已有仓库']) {
     const lib=await openLibrary(join(dir,name),{show:true});await ready(lib);await checkLayout(lib)
     const call=core(lib)
     if(name==='视觉新库') {
       assert.equal((await call('get',[saved.ids[0]]))[0].blocks.rating.data.value,5)
       assert.deepEqual((await call('query',saved.query)).ids,[saved.ids[0]])
       assert((await call('get',[saved.view]))[0].blocks.view)
     } else {
       assert.equal((await call('get',[saved.old]))[0].blocks.text.data.content,'已有资料，应用套件后保留')
       assert.equal((await call('plugins')).find(p => p.id === 'audio')?.enabled, false)
     }
   }
   writeFileSync(join(dir,'resume-result.json'),JSON.stringify({restart:true,selection:true,layout:true,data:true,savedView:true}));app.exit(0);return
 }
 await until(()=>launcherWindow(),'开始窗口')
 const launcher=launcherWindow()!,js=script(launcher),s=(code:string)=>settingsScript(launcher,code)
 await until(()=>js(`!!document.querySelector('.launcher-home-actions')`),'首页')
 await click(js,'.launcher-home-actions button','创建')
 await js(`(()=>{const e=document.querySelector('#launcher-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'视觉新库');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await pause()
 const nativeDialog=dialog.showOpenDialog
 dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[dir]})) as typeof nativeDialog
 try { await click(js,'.launcher-create button','选择位置…') } finally { dialog.showOpenDialog=nativeDialog }
 await click(js,'.launcher-create button','更多方案…')
 await click(js,'.starting-preset button','安装套件…')
 await until(()=>s(`!!document.querySelector('.application-settings')`),'应用设置')
 assert.deepEqual(await s(`[...document.querySelectorAll('.application-settings-nav button')].map(b=>b.textContent)`), appNavigation)
 assert.deepEqual(await s("[...document.querySelectorAll('.package-settings .ui-section-header h3,.package-settings .ui-section-header h2')].map(h=>h.textContent)"), ['已登记套件','已安装插件包'])
 writeFileSync(join(dir, 'launcher-package-settings.png'), (await findSettingsSurface(launcher)!.webContents.capturePage()).toPNG())
 await until(()=>s("!!document.querySelector('.global-data-maintenance > summary')?.checkVisibility()"),'开始页设置的高级维护入口')
 assert.equal(await s("document.querySelector('.global-data-maintenance').open"),false)
 await s("document.querySelector('.global-data-maintenance > summary').click()")
 await until(()=>s("!!document.querySelector('[data-local-maintenance=application]')?.checkVisibility()"),'全局本机数据')
 await s("document.querySelector('.global-data-maintenance > summary').click()")
 process.env.CAPTURE_DIR=dir;selectCapturePackage(process.env.VISUAL_SUITE_FILE!)
 await click(s,'.application-settings button','安装套件或插件包…')
 await until(()=>s(`!!document.querySelector('[data-suite-status="ready"]')`),'套件预览')
 assert.equal(await s(`document.querySelector('[data-install-group=same]').open`),false)
 assert.ok(await s(`document.querySelector('select[aria-label="palette安装方式"]').selectedOptions[0].textContent.includes('使用已安装')`))
 await s(`document.querySelector('[data-action="install-packages"]').click()`)
 await until(()=>s(`!!document.querySelector('[data-suite-status="installed"]')`),'安装完成')
 await until(()=>js(`document.querySelector('.starting-nav-item.active')?.textContent.includes('视觉素材库')`),'自动选中候选')
 await click(s,'.package-dialog button','用此方案新建仓库 →')
 await until(()=>js(`!!document.querySelector('.starting-layout')`),'方案详情')
 await click(js,'.launcher-preset-page button','确认选择此方案')
 await until(()=>js(`!document.querySelector('.launcher-create-btn').disabled`),'允许创建')
 await click(js,'.launcher-primary-card button','创建并打开')
 await until(()=>openLibraries().find(l=>l.root===join(dir,'视觉新库')),'新库')
 const lib=openLibraries().find(l=>l.root===join(dir,'视觉新库'))!,call=core(lib),main=script(lib.win)
 await ready(lib);await checkLayout(lib)
 assert.equal(lib.packages.find(p=>p.manifest.id==='palette')?.hash,JSON.parse(readFileSync(join(dir,'local-palette.json'),'utf8')).hash)
 const ids:string[]=[]
 for(const [i,[w,h,color]] of ([[400,200,'#ff0000'],[400,200,'#0000ff'],[200,400,'#ff0000']] as const).entries()) {
   const path=join(dir,`sample-${i}.png`), image=sharp({create:{width:w,height:h,channels:3,background:color}})
   if(i===0) image.composite([{input:await sharp({create:{width:160,height:h,channels:3,background:'#0000ff'}}).png().toBuffer(),left:0,top:0}])
   await image.png().toFile(path)
   ids.push(...await call('ingest',[{type:'file',path}]))
 }
 await until(async()=>(await call('get',ids)).every(v=>v.blocks.thumb&&v.blocks['image-filter.geometry']&&v.blocks['palette.families']),'真实图片加工')
 const palette=(await call('get',[ids[0]]))[0].blocks.palette.data
 const colors=palette.colors as string[], weights=palette.weights as number[]
 assert(colors.some(c=>parseInt(c.slice(1,3),16)>180 && parseInt(c.slice(5,7),16)<80))
 assert(colors.some(c=>parseInt(c.slice(5,7),16)>180 && parseInt(c.slice(1,3),16)<80))
 assert(Math.abs(weights.reduce((a,b)=>a+b,0)-1)<0.05)
 await call('run','rating','set',{ids:[ids[0]],value:5})
 await call('run','tags','update',{ids:[ids[0]],add:['精选'],remove:[]})
 const group=await call('run','collection','create',{title:'参考图片',ids:[ids[0]]})
 assert(group)
 const query={scope:'content' as const,where:[{op:'range' as const,kind:'rating',field:'value',min:4},{op:'eq' as const,kind:'image-filter.geometry',field:'shape',value:'横图'},{op:'eq' as const,kind:'palette.families',field:'values',value:'红色'}]}
 assert.deepEqual((await call('query',query)).ids,[ids[0]])
 await executeUiCommand(main,'host.view.all')
 await click(main,'.rm-rating-filters button','4★及以上')
 await main(`[...document.querySelectorAll('.rm-image-filter-pills button')].find(b=>b.textContent.includes('横图')&&!b.textContent.includes('长')).click()`)
 await main(`document.querySelector('.rm-palette-families [data-family="红色"]').click()`)
 await until(()=>main(`document.querySelectorAll('[data-tab-focused="true"] [data-entity-id]').length===1`),'三项组合筛选')
 const view=await call('create',{view:{title:'红色横图精选',query}})
 writeFileSync(join(dir,'visual-library.png'),(await lib.win.webContents.capturePage()).toPNG())
 const existing=await openLibrary(join(dir,'已有仓库'),{show:true})
 const ej=script(existing.win),ec=core(existing)
 await until(()=>ej(`!!document.querySelector('[aria-label="打开命令面板"]')`),'已有仓库界面')
 // 仓库曾绑定随套件保存的色板，本机目前只有另一个同版本构建。
 const savedColor = suite.manifest.packages.find(p => p.id === 'palette')!
 const localColor = JSON.parse(readFileSync(join(dir, 'local-palette.json'), 'utf8'))
 await ec('setExternalPlugin', { manifest: localColor.manifest, hash: savedColor.hash, enabled: false })
 const [old]=await ec('ingest',[{type:'text',text:'已有资料，应用套件后保留'}])
 await executeUiCommand(ej,'host.view.all')
 await until(()=>ej(`!!document.querySelector('[data-entity-id="${old}"]')`),'已有卡片')
 await ej(`document.querySelector('[data-entity-id="${old}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
 await until(async()=>((await ej(`window.bridge.loadWorkspace(${JSON.stringify(existing.id)})`))?.tabs.length??0)>1,'原有阅读页保存')
 const priorTabs=(await ej(`window.bridge.loadWorkspace(${JSON.stringify(existing.id)})`)).tabs.map((t:any)=>t.id)
 const comparison = await ej("window.bridge.pluginPresets.save('当前仓库的组合')")
 await applyFromSettings(existing, comparison.id)
 // 保留阅读页时筛选工具可为空；切回全部后再核验布局和工具。
 await executeUiCommand(ej,'host.view.all');await ready(existing)
 const before=await checkLayout(existing)
 assert(priorTabs.every((id:string)=>before.tabs.some((t:any)=>t.id===id)),'应用后保留原有页面')
 assert.equal((await ec('get',[old]))[0].blocks.text.data.content,'已有资料，应用套件后保留')
 const processBefore=existing.core
 await applyFromSettings(existing);await ready(existing)
 const after=await checkLayout(existing)
 assert.equal(existing.core,processBefore,'插件已满足时不重载')
 assert.deepEqual(after.tabs.map((t:any)=>t.id).sort(),before.tabs.map((t:any)=>t.id).sort(),'重复应用不增页')
 writeFileSync(join(dir,'existing-library.png'),(await existing.win.webContents.capturePage()).toPNG())
 // 同 ID 更新只更新方案目录；用户副本、现有布局和已选包不变。
 const sj=(code:string)=>settingsScript(existing.win,code)
 const copy=await ej(`window.bridge.pluginPresets.copy(${JSON.stringify(scheme)},'保留的用户副本')`)
 existing.win.webContents.send('menu:command','settings')
 await until(()=>findSettingsSurface(existing.win),'更新设置窗口')
 await until(()=>sj(`!!document.querySelector('.settings-nav-scroll')`),'更新导航')
 await click(sj,'.settings-nav-scroll button','套件与插件包')
 await until(()=>sj(`!!document.querySelector('.plugin-suite-card')`),'套件目录')
 selectCapturePackage(join(dir,'next.rmsuite'))
 await click(sj,'.plugin-suite-card button','更新套件…')
 await until(()=>sj(`!!document.querySelector('[data-suite-status="ready"]')`),'套件更新预览')
 assert.ok(await sj(`document.querySelector('.package-dialog').innerText.includes('工作台安排变化')`))
 await sj(`document.querySelector('[data-action="install-packages"]').click()`)
 await until(()=>sj(`!!document.querySelector('[data-suite-status="installed"]')`),'套件更新完成')
 const keptCopy=(await ej('window.bridge.pluginPresets.list()')).find((p:any)=>p.id===copy.id)
 assert.deepEqual(keptCopy.plugins,copy.plugins);assert.deepEqual(keptCopy.layout,copy.layout)
 const unchanged=await checkLayout(existing)
 for(const key of ['editors','tabs','panels','sidebars']) assert.deepEqual(unchanged[key],after[key])
 await click(sj,'.package-dialog-actions button','完成')
 findSettingsSurface(existing.win)?.close()
 await until(()=>!findSettingsSurface(existing.win),'更新设置关闭')
 writeFileSync(join(dir,'state.json'),JSON.stringify({ids,view,old,query}))
 writeFileSync(join(dir,'first-result.json'),JSON.stringify({installedPackages:8,newLibrary:true,existingLibrary:true,repeatWithoutReload:true,imagesProcessed:true,combinedFilters:true,existingData:true,alternateBuildReused:true,suiteUpdatePreservesWorkspace:true}))
 app.exit(0)
}).catch(async e=>{console.error(e);for(const [i,w] of BrowserWindow.getAllWindows().entries()){try{writeFileSync(join(dir,`failure-${i}.png`),(await w.webContents.capturePage()).toPNG());writeFileSync(join(dir,`failure-${i}.txt`),await w.webContents.executeJavaScript('document.body.innerText'))}catch{}}app.exit(1)})
