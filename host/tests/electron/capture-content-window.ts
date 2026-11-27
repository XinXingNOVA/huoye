import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { findProgram, programDirectories } from '../../src/platform/programs'
import { BrowserWindow } from 'electron'
import { localPackages } from '../../src/main/plugin-packages'
import { encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { reloadRenderer } from '../../src/main/page-lifecycle'
import sharp from 'sharp'
import { imagePdf } from '../helpers/image-pdf'
import { callCore } from '../../src/main/core-client'
import { routeAuxiliaryCommand, toggleContentWindowMode } from '../../src/main/auxiliary-windows'

export async function contentWindowFlow(owner: BrowserWindow, dir: string, choose: (label: string) => void) {
  const js = (code: string) => owner.webContents.executeJavaScript(code)
  const wait = (ms = 120) => new Promise(r => setTimeout(r, ms))
  const until = async (check: () => Promise<unknown> | unknown, label: string) => {
    for (let i = 0; i < 120; i++) { if (await check()) return; await wait() }
    throw new Error(label)
  }
  const children = () => BrowserWindow.getAllWindows().filter(w => w !== owner && !w.isDestroyed() && w.webContents.getURL() === 'about:blank')
  const snapshot = async () => { await wait(500); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(owner.webContents)!.id)})`) }
  await until(() => js(`!!document.querySelector('.editor-group')`), '主窗口未就绪')
  const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'popout-probe', title: '内容窗口验证', version: '1.0.0', author: 'test', description: '', uiFeatures: ['page-lifecycle-v1','tool-placement-v1'], entries: { ui: 'ui.mjs' } })
  const source = `const React=globalThis.__rmPluginSdk.react;
const {useUiEffect,useUiFrame}=globalThis.__rmPluginSdk['@resource-manager/plugin-api/ui/hooks'];
const {UiPortal,useUiDocument}=globalThis.__rmPluginSdk['@resource-manager/plugin-api/ui/widgets'];
export const plugin={id:'popout-probe',windowProviders:[{id:'popout-probe.host',order:1,Component:({host,children})=>{globalThis.__popHost=host;return children}}],
tabTypes:[{id:'popout-probe.page',key:p=>p.name,Title:({params})=>params.name,
beforeLeave:async c=>{if(globalThis.__rejectClose===c.params.name)throw Error('验证保存失败');(globalThis.__leaves??=[]).push(c.params.name)},
Component:({id,host,params,expose})=>{const root=React.useRef(null),doc=useUiDocument(),frame=useUiFrame();useUiEffect(d=>{const stats=globalThis.__displayStats??={};const item=stats[params.name]??={keys:0,bindings:0,cleanups:0};item.bindings++;d.onWindow('keydown',e=>{if(e.key==='F8')item.keys++});d.observeResize(root.current,()=>item.width=root.current.clientWidth);d.observeIntersection(root.current,([e])=>item.visible=e.isIntersecting);d.observeMutations(root.current,()=>item.mutated=true,{childList:true});frame(()=>item.frame=true);return()=>item.cleanups++},[params.name,frame]);const [value,set]=React.useState('初始内容');React.useEffect(()=>{globalThis.__mounts=(globalThis.__mounts??0)+1;expose({context:{title:params.name}})},[]);return React.createElement('div',{ref:root},React.createElement(UiPortal,null,React.createElement('span',{hidden:true,'data-display-probe':params.name,'data-doc':doc.title})),React.createElement('textarea',{'data-probe':params.name,value,onChange:e=>set(e.target.value)}),React.createElement('button',{'data-dialog':true,onClick:()=>host.showDialog(()=> '小窗弹窗')},'弹窗'))}}]};`
  localPackages().install(encodePackage(manifest, new Map([['ui.mjs', Buffer.from(source)]])))
  const installed = localPackages().list().find(p => p.manifest.id === manifest.id)!
  await js(`window.bridge.packages.apply({disabled:[],changes:[{hash:${JSON.stringify(installed.hash)},enabled:true}]})`)
  owner.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('[renderer]', event.message) })
  await reloadLibrary(libraryOf(owner.webContents)!)
  await until(() => js(`!!globalThis.__popHost`), '验证插件未启用')
  const core = libraryOf(owner.webContents)!.core
  const open = async (name: string) => {
    await js(`globalThis.__popHost.openTab('popout-probe.page',{name:${JSON.stringify(name)}})`)
    return (await snapshot()).active as string
  }
  const first = await open('甲'), second = await open('乙')
  const detach = async (id: string, win = owner) => {
    choose('移到新窗口')
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  }
  await detach(first)
  await until(() => children().length === 1, '标签未创建小窗')
  const child = children()[0], c = (code: string) => child.webContents.executeJavaScript(code)
  await until(() => c(`!!document.querySelector('[data-probe="甲"]')`), '小窗未承载原页面')
  if (process.platform === 'darwin') {
    assert.equal(child.getContentBounds().y, child.getBounds().y, '小窗仍存在独立系统标题栏')
    const header = await c(`(()=>{const bar=document.querySelector('.window-toolbar'),tab=document.querySelector('.tab');return {top:bar.getBoundingClientRect().top,left:tab.getBoundingClientRect().left,drag:getComputedStyle(bar).webkitAppRegion,tabDrag:getComputedStyle(tab).webkitAppRegion}})()`)
    assert.equal(header.top, 0)
    assert(header.left >= 88, '标签遮挡原生窗口按钮')
    assert.equal(header.drag, 'drag')
    assert.equal(header.tabDrag, 'no-drag')
  }
  assert.equal(await js(`globalThis.__mounts`), 2, '移动重建了内容实例')
  assert.equal(libraryOf(owner.webContents)!.core, core)
  assert.equal(await c(`typeof window.bridge`), 'undefined')
  assert.equal(await js(`!!document.querySelector('[data-probe="甲"]')`), false)
  await until(() => js(`globalThis.__displayStats['甲'].width>300 && globalThis.__displayStats['甲'].visible && globalThis.__displayStats['甲'].frame`),'公共显示观察器未跟随小窗')
  assert.equal(await c(`!!document.querySelector('[data-display-probe="甲"]')`),true)
  assert.equal(await js(`!!document.querySelector('[data-display-probe="甲"]')`),false)
  const keys=await js(`globalThis.__displayStats['甲'].keys`)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F8'}))`)
  assert.equal(await js(`globalThis.__displayStats['甲'].keys`),keys,'移窗后仍监听旧窗口')
  await c(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F8'}));document.querySelector('[data-probe="甲"]').parentElement.append(document.createElement('i'))`)
  await until(() => js(`globalThis.__displayStats['甲'].mutated`),'小窗 DOM 观察器失效')
  assert.equal(await js(`globalThis.__displayStats['甲'].keys`),keys+1,'小窗事件丢失或重复')
  child.focus()
  await c(`document.querySelector('textarea').focus()`)
  routeAuxiliaryCommand(child, 'selectAll'); await wait(); await child.webContents.insertText('小窗编辑')
  await until(() => c(`document.querySelector('textarea').value==='小窗编辑'`), '小窗输入失败')
  await c(`document.querySelector('[data-dialog]').click()`)
  await until(() => c(`!!document.querySelector('.quick-attach')`), '弹窗没有跟随内容')
  assert.equal(await js(`!!document.querySelector('.quick-attach')`), false)
  await c(`document.querySelector('.quick-attach').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  // 同一会话的拖放：移动第二页进入小窗，不能复制页面或另启业务运行时。
  await js(`window.__transfer=new DataTransfer();document.querySelector('[data-tab="${second}"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__transfer}))`)
  await js(`(()=>{const w=window.open('','rm-content:${(await snapshot()).editors.groups.find((g: any) => g.window).id}');const el=w.document.querySelector('[data-editor-group]');const r=el.getBoundingClientRect();el.dispatchEvent(new w.DragEvent('drop',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+80,dataTransfer:window.__transfer}))})()`)
  await until(() => c(`!!document.querySelector('[data-tab="${second}"]')`), '跨窗移入失败')
  await js(`globalThis.__rejectClose='乙'`)
  child.close()
  await until(() => c(`document.body.textContent.includes('验证保存失败')`), '关闭未经过保存检查')
  assert.equal(children().length, 1)
  assert.equal((await snapshot()).editors.groups.find((g: any) => g.window).tabs.length, 2, '保存失败后部分标签被关闭')
  await js(`globalThis.__rejectClose=undefined`)
  // 移回是位置操作，不结束内容。
  const count = await js(`globalThis.__leaves.length`)
  choose('全部移回主窗口'); await c(`document.querySelector('[aria-label="区域操作"]').click()`)
  await until(() => !children().length, '移回后空窗未关闭')
  assert.equal(await js(`globalThis.__leaves.length`), count)
  assert.equal(await js(`document.querySelector('[data-probe="甲"]').value`), '小窗编辑')
  assert.equal(await js(`globalThis.__mounts`), 2)
  const returnedKeys=await js(`globalThis.__displayStats['甲'].keys`)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'F8'}))`)
  assert.equal(await js(`globalThis.__displayStats['甲'].keys`),returnedKeys+1,'移回后监听未接续或重复')
  assert.equal(await js(`globalThis.__displayStats['甲'].bindings-globalThis.__displayStats['甲'].cleanups`),1,'显示资源未对称清理')
  await detach(first)
  await until(() => children().length === 1, '再次移出失败')
  await until(() => children()[0].webContents.executeJavaScript(`!!document.querySelector('[data-probe="甲"]')`), '再次移出未挂载')
  children()[0].setBounds({x:80,y:120,width:780,height:600}); await wait(500)
  const restoredBounds=children()[0].getBounds()
  await reloadRenderer(owner)
  await until(() => js(`!!document.querySelector('.editor-group')`), '重载主窗口失败')
  await until(() => children().length === 1 && children()[0].webContents.executeJavaScript(`!!document.querySelector('[data-probe="甲"]')`), '重载丢失浮动位置')
  assert.deepEqual(children()[0].getBounds(),restoredBounds,'重载没有恢复窗口位置与大小')
  children()[0].close()
  await until(() => !children().length, '小窗正常关闭失败')
  assert(!(await snapshot()).tabs.some((t: any) => t.id === first), '关窗应关闭其中内容')
  assert((await snapshot()).tabs.some((t: any) => t.id === second), '关闭小窗影响其他页面')
  // Chromium 真实起拖；接管落点到窗口之外，并核验取消不会建窗。
  owner.focus(); owner.setBounds({ x: 60, y: 80, width: 1000, height: 700 }); await wait()
  owner.webContents.debugger.attach('1.3')
  await owner.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await owner.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
  let dragData: any
  owner.webContents.debugger.on('message', (_e, method, params) => { if (method === 'Input.dragIntercepted') dragData = params.data })
  const dragOutside = async (selector: string, cancel = false) => {
    dragData = undefined
    const at = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({inline:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const send = (type: string, x: number, y: number) => owner.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type,x,y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mousePressed'||type==='mouseReleased'?1:0 })
    await send('mouseMoved',at.x,at.y); await send('mousePressed',at.x,at.y)
    await send('mouseMoved',at.x+8,at.y+8); await send('mouseMoved',at.x+16,at.y+16)
    await until(() => !!dragData, '原生拖动未启动')
    const point = { x: 1100, y: 300 }
    if (cancel) { owner.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'}); await wait() }
    await owner.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: cancel ? 'dragCancel' : 'drop', ...point, data: dragData })
    await send('mouseReleased',point.x,point.y); await wait(500)
  }
  try {
    await dragOutside(`[data-tab="${second}"]`, true)
    assert.equal(children().length, 0, '取消拖动不能建立窗口')
    await dragOutside(`[data-tab="${second}"]`)
    await until(() => children().length === 1, '拖出应用没有建立窗口')
    await until(() => children()[0].webContents.executeJavaScript(`!!document.querySelector('[data-probe="乙"]')`), '拖出后没有原内容')
    children()[0].close(); await until(() => children().length === 0, '拖出窗口关闭失败')
    await dragOutside('[id="tool-tab-host.navigation"]')
    await until(() => children().length === 1, '侧栏工具拖出没有建窗')
    children()[0].close(); await until(() => children().length === 0, '侧栏小窗关闭失败')
    await js(`globalThis.__popHost.showView('host.navigation')`)
  } finally { owner.webContents.debugger.detach() }

  owner.setSize(1600,900); await wait()
  const currentCore = () => libraryOf(owner.webContents)!.core
  const text = await callCore(currentCore(), 'create', { text: { content: '原文字' } })
  await js(`globalThis.__popHost.openTab('text.reader',{id:${JSON.stringify(text)},edit:true})`)
  const textA = (await snapshot()).active
  choose('在另一组新建此内容的视图')
  await js(`document.querySelector('[data-tab="${textA}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  const textB = (await snapshot()).active
  assert.notEqual(textA,textB,'文字没有创建第二个视图')
  await detach(textB)
  await until(() => children().length === 1, '文字未移窗')
  const textWin=children()[0], tj=(code:string)=>textWin.webContents.executeJavaScript(code)
  await until(() => tj(`!!document.querySelector('textarea')`), '文字编辑器未就绪')
  textWin.focus(); await tj(`document.querySelector('textarea').focus()`)
  routeAuxiliaryCommand(textWin,'selectAll'); await wait(); await textWin.webContents.insertText('跨窗口共享草稿')
  await until(() => js(`document.querySelector('[data-tab-content="${textA}"] textarea')?.value==='跨窗口共享草稿'`), '主窗没有共享草稿')
  routeAuxiliaryCommand(textWin,'undo'); await wait()
  assert.equal(await tj(`document.querySelector('textarea').value`), '原文字')
  routeAuxiliaryCommand(textWin,'redo'); await wait()
  assert.equal(await tj(`document.querySelector('textarea').value`), '跨窗口共享草稿')
  await tj(`[...document.querySelectorAll('button')].find(b=>b.textContent==='完成').click()`)
  await until(() => tj(`!!document.querySelector('.reader-doc p') && !!document.querySelector('.content-selection-layers')`),'阅读选区未就绪')
  await wait(350) // 等阅读模式的首次排版／ResizeObserver 完成后再划选。
  await tj(`(()=>{const p=document.querySelector('.reader-doc p'),r=document.createRange();r.selectNodeContents(p);const s=window.getSelection();s.removeAllRanges();s.addRange(r);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})()`)
  await until(() => tj(`!!document.querySelector('.content-selection-menu')`),'选区菜单未进入小窗')
  assert.equal(await js(`globalThis.__popHost.selection.getSnapshot()?.sourceId`),text)
  assert.equal(await js(`!!document.querySelector('.content-selection-menu')`),false)
  routeAuxiliaryCommand(textWin,'commands')
  await until(() => tj(`!!document.querySelector('.command-palette')`),'命令面板未进入小窗')
  assert.equal(await js(`!!document.querySelector('.command-palette')`),false)
  await tj(`document.querySelector('.command-palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  textWin.close(); await until(() => children().length === 0, '文字窗口关闭失败')
  assert.equal((await callCore(currentCore(),'get',[text]))[0].blocks.text.data.content,'跨窗口共享草稿')

  // 集合跨窗后按所在容器测量，不依赖主窗外壳；缩放与移回仍用同一瀑布流。
  for (let i=0;i<8;i++) await callCore(currentCore(),'create',{text:{content:`小窗布局 ${i}\n\n检查瀑布流宽度`}})
  await js(`globalThis.__popHost.openTab('collection',{title:'布局验证',query:{scope:'content'}})`)
  const gridTab=(await snapshot()).active
  await until(() => js(`document.querySelectorAll('[data-tab-content="${gridTab}"] .card').length>=8`),'主窗集合未就绪')
  await detach(gridTab); await until(() => children().length===1,'集合未移窗')
  const gridWin=children()[0], gj=(code:string)=>gridWin.webContents.executeJavaScript(code)
  const gridGeometry=()=>gj(`(()=>{const root=document.querySelector('.editor-workspace'),probe=document.querySelector('.editor-size-probe'),grid=document.querySelector('.grid-scroller'),cards=[...document.querySelectorAll('.card')];return {width:root.clientWidth,probe:probe.getBoundingClientRect().width,grid:grid?.clientWidth,columns:new Set(cards.map(c=>Math.round(c.getBoundingClientRect().left))).size}})()`)
  await until(() => gj(`document.querySelectorAll('.card').length>=3`),'小窗集合未绘制')
  gridWin.setSize(1000,760); await wait(400)
  const wideGrid=await gridGeometry()
  assert(Math.abs(wideGrid.width-wideGrid.probe)<=1,`小窗容器宽度错误：${JSON.stringify(wideGrid)}`)
  assert(wideGrid.columns>=3,`小窗瀑布流未按容器分列：${JSON.stringify(wideGrid)}`)
  writeFileSync(join(dir,'content-grid-wide.png'),(await gridWin.webContents.capturePage()).toPNG())
  gridWin.setSize(580,760); await wait(400)
  const narrowGrid=await gridGeometry()
  assert(narrowGrid.columns>=2 && narrowGrid.columns<wideGrid.columns,`小窗缩放未重新分列：${JSON.stringify(narrowGrid)}`)
  choose('全部移回主窗口'); await gj(`document.querySelector('[aria-label="区域操作"]').click()`)
  await until(() => !children().length,'集合未移回')
  await until(() => js(`new Set([...document.querySelectorAll('[data-tab-content="${gridTab}"] .card')].map(c=>Math.round(c.getBoundingClientRect().left))).size>=3`),'移回主窗没有恢复分列')

  // 图片的适应尺寸也随显示窗口变化，不能继续监听主窗口。
  const imagePath=join(dir,'小窗图片.png')
  writeFileSync(imagePath,await sharp({create:{width:2000,height:800,channels:3,background:'#7599bb'}}).png().toBuffer())
  const [picture]=await callCore(currentCore(),'ingest',[{type:'file',path:imagePath}])
  await until(async () => !!(await callCore(currentCore(),'get',[picture]))[0]?.blocks.image,'图片尚未加工完成')
  await js(`globalThis.__popHost.open(${JSON.stringify(picture)})`)
  await detach((await snapshot()).active); await until(() => children().length===1,'图片未移窗')
  const imageWin=children()[0], ij=(code:string)=>imageWin.webContents.executeJavaScript(code)
  imageWin.setSize(1000,760)
  await until(() => ij(`document.querySelector('.viewer-image')?.clientWidth>800`),'图片未适应小窗宽度')
  imageWin.setSize(580,760)
  await until(() => ij(`document.querySelector('.viewer-image')?.clientWidth<580 && document.querySelector('.viewer-image')?.clientWidth>450`),'图片未随小窗缩放')
  imageWin.close(); await until(() => !children().length,'图片小窗未关闭')

  // 新导入 PDF：原查看器、跳页与关闭保存协议都在小窗中运行。
  const pdf=join(dir,'小窗阅读.pdf')
  writeFileSync(pdf,imagePdf(await sharp({create:{width:400,height:300,channels:3,background:'#7599bb'}}).jpeg().toBuffer(),400,300,4))
  const [book]=await callCore(currentCore(),'ingest',[{type:'file',path:pdf}])
  await until(async () => !!(await callCore(currentCore(),'get',[book]))[0]?.blocks.pdf,'新 PDF 尚未加工完成')
  await callCore(currentCore(),'put',book,'pdfreading',{page:1,offset:0,lastRead:1})
  await js(`globalThis.__popHost.open(${JSON.stringify(book)})`)
  const pdfTab=(await snapshot()).active
  await detach(pdfTab); await until(() => children().length===1,'PDF 未移窗')
  const pdfWin=children()[0], pj=(code:string)=>pdfWin.webContents.executeJavaScript(code)
  await until(() => pj(`!!document.querySelector('.pdf-page canvas')`),'PDF 小窗未绘制')
  toggleContentWindowMode(pdfWin, 'pinned')
  toggleContentWindowMode(pdfWin, 'minimal')
  await until(() => pj("!!document.querySelector('.content-window[data-minimal]')"), 'PDF 未进入精简模式')
  assert(pdfWin.isAlwaysOnTop())
  pdfWin.focus()
  const center = await pj('Math.floor(innerWidth / 2)')
  pdfWin.webContents.sendInputEvent({ type: 'mouseMove', x: center, y: 2 })
  await until(() => pj("document.querySelector('.content-mini-controls').getBoundingClientRect().top >= 0"), '顶边工具条未展开')
  const grip = await pj("(()=>{const r=document.querySelector('.content-mini-controls .window-drag-space').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")
  pdfWin.webContents.sendInputEvent({ type: 'mouseMove', ...grip })
  assert(await pj(`(async()=>{
    const controls = document.querySelector('.content-mini-controls')
    for (let i = 0; i < 12; i++) {
      await new Promise(done => requestAnimationFrame(done))
      if (controls.getBoundingClientRect().top < 0) return false
    }
    return true
  })()`), '指针停在拖动区时工具条收起')
  pdfWin.webContents.sendInputEvent({ type: 'mouseMove', x: center, y: 90 })
  await until(() => pj("document.querySelector('.content-mini-controls').getBoundingClientRect().top < 0"), '离开工具条未收起')
  await pj("[...document.querySelectorAll('.content-mini-controls button')].find(b => b.textContent === '退出精简').click()")
  await until(() => pj("!document.querySelector('.content-window[data-minimal]')"), 'PDF 小窗未退出精简模式')
  assert(pdfWin.isAlwaysOnTop())
  pdfWin.setSize(1000,760)
  await until(() => pj(`document.querySelector('.pdf-page')?.clientWidth>800`),'PDF 未适应小窗宽度')
  pdfWin.setSize(580,760)
  await until(() => pj(`document.querySelector('.pdf-page')?.clientWidth<580 && document.querySelector('.pdf-page')?.clientWidth>450`),'PDF 未随小窗缩放')
  await pj(`document.querySelector('.pdf-page-jump').click()`)
  await pj(`(()=>{const el=document.querySelector('input[aria-label="跳转页码"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'3');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
  await until(() => pj(`document.querySelector('.pdf-page-jump')?.textContent.includes('3 /')`),'PDF 小窗跳页失败')
  await until(() => pj(`document.querySelector('.pdf-page[data-page="3"] canvas')?.width>600`),'滚到后面的 PDF 页没有真正绘制')
  await wait(650)
  writeFileSync(join(dir,'content-window.png'),(await pdfWin.webContents.capturePage()).toPNG())
  pdfWin.close(); await until(() => children().length===0,'PDF 小窗关闭失败')
  assert.equal((await callCore(currentCore(),'get',[book]))[0].blocks.pdfreading.data.page,3)

  // 视频的全屏归实际文档，逐帧时钟随显示窗口，播放记录仍属原会话。
  const ffmpeg=findProgram('ffmpeg',programDirectories([resolve(`resources/media/${process.platform}-${process.arch}/bin`)]))
  assert(ffmpeg,'需要 ffmpeg 生成临时视频')
  const videoPath=join(dir,'小窗视频.mp4')
  execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=10','-t','8','-c:v','libx264',videoPath],{timeout:20000})
  const [movie]=await callCore(currentCore(),'ingest',[{type:'file',path:videoPath}])
  await until(async () => !!(await callCore(currentCore(),'get',[movie]))[0]?.blocks.video,'视频尚未加工完成')
  owner.webContents.setAudioMuted(true)
  await js(`globalThis.__popHost.open(${JSON.stringify(movie)})`)
  const videoTab=(await snapshot()).active
  await detach(videoTab); await until(() => children().length===1,'视频未移窗')
  const videoWin=children()[0], vj=(code:string)=>videoWin.webContents.executeJavaScript(code,true)
  videoWin.webContents.setAudioMuted(true)
  await until(() => vj(`document.querySelector('video')?.readyState>=2`),'视频小窗未就绪')
  await vj(`(()=>{const v=document.querySelector('video');v.currentTime=2;v.play()})()`)
  await until(() => vj(`document.querySelector('.player-time')?.textContent.includes('0:02')`),'小窗播放条未更新')
  await vj(`document.querySelector('[title="全屏（F）"]').click()`)
  await until(() => vj(`!!document.fullscreenElement`),'小窗未进入全屏')
  await vj(`document.querySelector('[title="全屏（F）"]').click()`)
  await until(() => vj(`!document.fullscreenElement`),'小窗按钮无法退出全屏')
  await vj(`document.querySelector('video').pause()`)
  videoWin.close(); await until(() => !children().length,'视频小窗未关闭')
  await until(async () => Number((await callCore(currentCore(),'get',[movie]))[0]?.blocks.videoPlayback?.data.position)>=2,'小窗播放进度未保存')

  // 固定工具沿用原页面绑定；普通工具的允许区域限制仍有效。
  await js(`globalThis.__popHost.openTab('collection',{title:'全部',query:{scope:'content'}})`)
  const collection=(await snapshot()).active
  await until(() => js(`!!document.querySelector('[data-context-tool="host.filters"]')`),'筛选工具未出现')
  choose('在新窗口固定此工具')
  await js(`document.querySelector('[data-context-tool="host.filters"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  await until(() => children().length===1,'固定工具未创建小窗')
  const filterWin=children()[0], fj=(code:string)=>filterWin.webContents.executeJavaScript(code)
  await until(() => fj(`!!document.querySelector('.collection-filters')`),'固定筛选没有内容')
  await until(() => fj(`[...document.querySelectorAll('.facet-pill')].some(b=>b.querySelector('.nav-label')?.textContent==='pdf')`),'固定筛选未提供格式项')
  await fj(`[...document.querySelectorAll('.facet-pill')].find(b=>b.querySelector('.nav-label')?.textContent==='pdf').click()`)
  assert((await snapshot()).tabs.find((t:any)=>t.id===collection)?.state.filters.some((f:any)=>f.kind==='file' && f.value==='pdf'),'小窗筛选没有作用于来源集合')
  const binding=Object.values((await snapshot()).sidebars.bindings) as any[]
  assert.equal(binding[0].pageId,collection)
  await js(`globalThis.__popHost.openTab('popout-probe.page',{name:'另一页'})`)
  assert.equal((Object.values((await snapshot()).sidebars.bindings) as any[])[0].pageId,collection)
  assert.equal(await fj(`!!document.querySelector('.context-tool-empty')`),false,'固定工具跟随了新焦点')
  filterWin.close(); await until(() => children().length===0,'固定工具关闭失败')
  assert.equal(Object.keys((await snapshot()).sidebars.bindings ?? {}).length,0,'关闭未释放固定实例')
  choose('移到新窗口')
  await js(`document.querySelector('[id="tool-tab-host.navigation"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
  await until(() => children().length===1,'导航工具未移窗')
  await until(() => children()[0].webContents.executeJavaScript(`!!document.querySelector('.sidebar')`),'导航工具没有沿用界面')
  children()[0].close(); await until(() => children().length===0,'导航关闭失败')
  writeFileSync(join(dir, 'contentwindow-result.json'), JSON.stringify({ ok: true }))
}
