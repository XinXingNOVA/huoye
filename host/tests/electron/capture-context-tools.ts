import { executeUiCommand } from './capture-command'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function contextToolsFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu }: Tools) {
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 80; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const snapshot = async () => { await wait(600); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const click = async (selector: string) => {
    const match = selector.match(/^(.*) \[data-context-tool="([^"]+)"\]$/)
    if (match && !await js(`!!document.querySelector(${JSON.stringify(selector)})`)) {
      const names: Record<string, string> = { 'host.filters': '筛选', 'demo-tools.summary': '集合概况', 'demo-tools.reading': '阅读工具示例', 'demo-tools.reading-extra': '额外工具示例' }
      chooseMenu(names[match[2]])
      await js(`document.querySelector(${JSON.stringify(match[1] + ' .sidebar-tool-overflow')}).click()`)
    } else await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await wait()
  }
  const button = async (scope: string, text: string) => { await js(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`); await wait() }
  const activate = async (id: string) => { await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const smart = '.sidebar-group[data-container-type="context"]'
  const context = (id: string) => `.sidebar-group[data-container-type="context"][data-context-source="${id}"]`
  await until(`!!document.querySelector('${smart} .context-tool-slot')`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await js(`window.__facetCalls=[];window.__postMessage=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(message,...rest){if(message?.method==='facet')window.__facetCalls.push(message.args);return window.__postMessage.call(this,message,...rest)};void 0`)
  let dragData: any
  await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
  const intercepted = (_: Electron.Event, method: string, params: any) => { if (method === 'Input.dragIntercepted') dragData = params.data }
  win.webContents.debugger.on('message', intercepted)
  const drag = async (selector: string, target: string, fraction = .8, cancel = false) => {
    dragData = undefined
    const from = await js(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    for (const [type, dx] of [['mouseMoved',0],['mousePressed',0],['mouseMoved',8],['mouseMoved',16]] as const) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: from.x+dx, y: from.y+dx, button: type==='mouseMoved' && dx===0 ? 'none' : 'left', buttons: type==='mouseMoved' && dx===0 ? 0 : 1, clickCount: type==='mousePressed' ? 1 : 0 })
    }
    for (let i=0;i<30 && !dragData;i++) await wait(50)
    assert(dragData, '原生拖动未启动：'+selector)
    await until(`!!document.querySelector('.sidebar-layout-drop-layer')`)
    const to = await js(`(() => {const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height*${fraction}}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragEnter',...to,data:dragData})
    await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragOver',...to,data:dragData})
    await wait()
    assert(await js(`!!document.querySelector('.sidebar-layout-drop-preview[data-blocked="false"], .editor-drop-preview:not(.blocked)')`), '拖动落点不可用')
    if (cancel) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragCancel',...to,data:dragData})
    else await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'drop',...to,data:dragData})
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1})
    if (cancel) await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await wait()
  }
  try {
    if (process.env.CAPTURE_FLOW === 'contexttoolsresume') {
      const expected = JSON.parse(readFileSync(join(dir, 'context-tools-saved.json'), 'utf8')), current = await snapshot()
      assert.deepEqual(current.sidebars, expected.sidebars)
      assert.equal(current.active, expected.active)
      assert(await js(`!!document.querySelector('#inspector-panel ${smart}')`))
      assert.equal(await js(`document.querySelector('${context(current.active)} [role=tab][aria-selected=true]').dataset.contextTool`), 'demo-tools.summary')
      const bindings = Object.entries(current.sidebars.bindings) as [string, any][]
      assert.equal(bindings.length, 2)
      const dead = bindings.find(([, b]) => b.toolId === 'host.filters')!, live = bindings.find(([, b]) => b.toolId === 'demo-tools.reading')!
      await click(`[data-tool-id="${dead[0]}"] [role=tab]`)
      assert.equal(await js(`document.querySelector('[data-panel-content="${dead[0]}"] .context-tool-empty').textContent`), '目标页面已关闭')
      const liveTab = current.tabs.find((t: any) => t.type === 'workspace.tool' && t.params.toolId === live[0])
      if (liveTab) await activate(liveTab.id); else await click(`[data-tool-id="${live[0]}"] [role=tab]`)
      await until(`!!document.querySelector('[data-panel-content="${live[0]}"] [data-context-add]')`)
      const count = Number(await js(`document.querySelector('[data-panel-content="${live[0]}"] [data-context-count]').textContent`))
      await click(`[data-panel-content="${live[0]}"] [data-context-add]`)
      assert.equal(Number(await js(`document.querySelector('[data-panel-content="${live[0]}"] [data-context-count]').textContent`)), count + 1)
      assert.equal((await snapshot()).active, liveTab?.id ?? current.active)
      await shot('context-tools-restart.png')
    } else {
      const text = join(dir, 'one.txt'), png = join(dir, 'two.png')
      writeFileSync(text, 'Temporary collection context fixture')
      await sharp({ create: { width: 30, height: 20, channels: 3, background: '#87aabc' } }).png().toFile(png)
      await call('importToLibrary', [{ type: 'file', path: text }, { type: 'file', path: png }], { requestId: 'context-fixture' })
      const a = (await snapshot()).active
      await until(`document.querySelectorAll('${context(a)} .facet-pill').length>=2`)
      assert.equal(await js(`document.querySelectorAll('[data-panel-content="host.navigation"] .facet-group').length`), 0)
      await click('.tab-new'); const b = (await snapshot()).active
      await activate(a)
      await js(`document.querySelector('${context(a)} .facet-pill').click()`); await wait()
      await activate(b)
      assert.equal((await snapshot()).tabs.find((t: any) => t.id === b).state.filters.length, 0)
      // 捕获 A 的延迟动作，切换 B 后仍只修改 A。
      await activate(a); await click(`${context(a)} [data-context-tool="demo-tools.summary"]`)
      const before = (await snapshot()).tabs.find((t: any) => t.id === a).state.filters
      await click(`${context(a)} [data-delayed-filter]`); await activate(b); await wait(650)
      const changed = await snapshot()
      assert.notDeepEqual(changed.tabs.find((t: any) => t.id === a).state.filters, before)
      assert.equal(changed.tabs.find((t: any) => t.id === b).state.filters.length, 0)
      assert.equal(await js(`document.querySelector('${context(b)} [aria-selected=true]').dataset.contextTool`), 'demo-tools.summary')
      // 侧栏工具及设置浮层不成为上下文来源。
      await click('[aria-label="打开设置"]'); assert.equal((await snapshot()).active, b)
      await js(`document.querySelector('.settings-modal').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await until(`!document.querySelector('.settings-modal')`)
      await click('[data-quick-action="demo-tools.open-status"]'); await button('[data-panel-content="demo-tools.status"]', '打开示例 A')
      const reader = (await snapshot()).active
      await until(`!!document.querySelector('${context(reader)} [data-context-add]')`)
      assert.equal(await js(`document.querySelectorAll('${context(reader)} .context-tool-slot .facet-group').length`), 0)
      await wait(500); await js('window.__facetCalls=[]')
      const extra = join(dir, 'later.txt'); writeFileSync(extra, 'Background change while filters are hidden')
      await call('importToLibrary', [{ type: 'file', path: extra }], { requestId: 'context-hidden-change' }); await wait(700)
      assert.equal(await js('window.__facetCalls.length'), 0, '隐藏的筛选工具不继续查询分面')
      await click(`${context(reader)} [data-context-add]`)
      assert.equal(await js(`document.querySelector('${context(reader)} [data-context-count]').textContent`), '1')
      await js(`(() => { const el=document.querySelector('${context(reader)} input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'保留局部输入');el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await activate(b); await activate(reader)
      assert.equal(await js(`document.querySelector('${context(reader)} input').value`), '保留局部输入')
      chooseMenu('额外工具示例'); await click(`${context(reader)} .sidebar-group-menu`)
      await click(`${context(reader)} [data-context-tool="demo-tools.reading-extra"]`)
      await activate(b); await activate(reader)
      assert.equal(await js(`document.querySelector('${context(reader)} [aria-selected=true]').dataset.contextTool`), 'demo-tools.reading-extra')
      // 没有能力的页面保留分区及尺寸，不跳回其他集合。
      await click('[data-quick-action="demo-tools.open-status"]'); await button('[data-panel-content="demo-tools.status"]', '打开单例示例')
      const empty = (await snapshot()).active, height = await js(`document.querySelector('${smart}').getBoundingClientRect().height`)
      await until(`document.querySelector('${context(empty)} .context-tool-empty')?.textContent==='当前页面暂无适用工具'`)
      assert.equal((await snapshot()).active, empty)
      assert.equal(await js(`document.querySelector('${smart}').getBoundingClientRect().height`), height)
      await shot('context-tools-empty.png')
      // 固定筛选服务 A，智能组仍可服务 B；原生拖动验证真实起拖，不使用合成 dragstart。
      assert.equal(await js(`document.querySelectorAll('${smart}').length`), 1, '每组只能挂载一份智能容器')
      await activate(a); await click(`${context(a)} [data-context-tool="host.filters"]`)
      await drag(`${context(a)} [data-context-tool="host.filters"]`, '#inspector-panel .sidebar-group', .85)
      let bindings = (await snapshot()).sidebars.bindings
      const fixedFilter = Object.keys(bindings)[0]
      assert.equal(bindings[fixedFilter].pageId, a)
      assert(await js(`!!document.querySelector('${context(a)} [data-context-tool="host.filters"]')`), '拖出后保留智能入口')
      await activate(b)
      const bFilters = (await snapshot()).tabs.find((t:any)=>t.id===b).state.filters
      await click(`[data-panel-content="${fixedFilter}"] .facet-pill`)
      assert.deepEqual((await snapshot()).tabs.find((t:any)=>t.id===b).state.filters, bFilters)
      // 来源此前可能超出三页后台缓存；重新激活后，单独验证外壳移动而非页面缓存策略。
      await activate(reader); await click(`${context(reader)} [data-context-tool="demo-tools.reading"]`)
      await js(`(() => { const el=document.querySelector('${context(reader)} input');window.__smartInput=el;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'保留局部输入');el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await activate(b)
      // 紧凑抓手仍可原生起拖；上／下半区均能定位。取消不留半次移动。
      const layout = (await snapshot()).sidebars
      await drag(`${smart} .sidebar-group-grip`, '#inspector-panel .sidebar-group', .55, true)
      assert.deepEqual((await snapshot()).sidebars, layout)
      await drag(`${smart} .sidebar-group-grip`, '#inspector-panel .sidebar-group', .55)
      assert(await js(`!!document.querySelector('#inspector-panel ${smart}')`))
      assert.equal(await js(`document.querySelectorAll('${smart} .sidebar-group-heading').length`), 1)
      assert.equal(await js(`document.querySelectorAll('${smart} .context-tool-source, ${smart} .context-tool-tabs').length`), 0, '智能工具不再叠加来源栏与切换栏')
      // 菜单固定阅读工具；重复固定复用实例，移动不丢局部输入。
      await activate(reader); await click(`${context(reader)} [data-context-tool="demo-tools.reading"]`)
      assert(await js(`window.__smartInput===document.querySelector('${context(reader)} input') && window.__smartInput.value==='保留局部输入'`), '智能容器外壳跨侧重挂不得重建工具')
      chooseMenu('关闭此组工具'); await click(`${smart} .sidebar-group-menu`)
      assert(await js(`!document.querySelector('${smart}') && window.__smartInput.isConnected && !!window.__smartInput.closest('[data-surface-parking]')`), '关闭智能外壳后工具交由宿主停放')
      await executeUiCommand(js, 'host.context-tools'); await wait()
      assert(await js(`window.__smartInput===document.querySelector('${context(reader)} input') && window.__smartInput.value==='保留局部输入'`), '重开智能容器沿用原工具与草稿')
      const pinReading = async () => {
        chooseMenu('固定到左侧栏')
        await js(`document.querySelector('${context(reader)} [data-context-tool="demo-tools.reading"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await wait()
      }
      await pinReading(); await pinReading()
      bindings = (await snapshot()).sidebars.bindings
      assert.equal(Object.keys(bindings).length, 2)
      const fixedReader = Object.keys(bindings).find(id=>bindings[id].toolId==='demo-tools.reading')!
      assert(await js(`!document.querySelector('[data-tool-id="${fixedReader}"]').closest('.sidebar-group').querySelector('.sidebar-tool-source')`), '普通容器不因固定工具增加头部元素')
      assert(await js(`document.querySelector('[data-tool-id="${fixedReader}"] [role=tab]').title.includes('固定到：')`), '固定来源保留在完整提示中')
      assert(await js(`!!document.querySelector('${smart} .sidebar-tool-source')`), '智能容器仍保留跟随标识')
      await activate(b)
      chooseMenu('定位来源页面')
      await js(`document.querySelector('[data-tool-id="${fixedReader}"] [role=tab]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await wait()
      assert.equal((await snapshot()).active, reader, '固定工具菜单准确定位来源页')
      assert.equal(await js(`document.querySelectorAll('[data-panel-content="${fixedReader}"] .context-tool-source').length`), 0)
      const input = `[data-panel-content="${fixedReader}"] input`
      await js(`(() => {const el=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'固定工具草稿');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await drag(`[data-tool-id="${fixedReader}"] [role=tab]`, '#inspector-panel .sidebar-group-heading', .5)
      assert.equal(await js(`document.querySelector(${JSON.stringify(input)}).value`), '固定工具草稿')
      // 中央标签／边缘分区与两侧共用同一个实例；拖进中央后焦点不伪装成来源。
      await js(`window.__fixedInput=document.querySelector(${JSON.stringify(input)});void 0`)
      await drag(`[data-tool-id="${fixedReader}"] [role=tab]`, '.editor-group', .9)
      let central = (await snapshot()).tabs.find((t:any)=>t.type==='workspace.tool' && t.params.toolId===fixedReader)
      assert(central, '固定工具进入中央标签组')
      assert.equal(await js(`document.querySelectorAll('[data-panel-content="${fixedReader}"] .context-tool-source').length`), 1, '移入中央后仍可看到固定来源')
      assert(await js(`window.__fixedInput===document.querySelector(${JSON.stringify(input)})`), '跨区不得重建输入组件')
      assert.equal(await js(`document.querySelector(${JSON.stringify(input)}).value`), '固定工具草稿')
      assert(await js(`!!document.querySelector('${smart} .context-tool-empty')`), '工具焦点不成为智能工具的来源')
      await click(`[data-panel-content="${fixedReader}"] [data-context-add]`)
      assert.equal((await snapshot()).tabs.find((t:any)=>t.id===reader).state.keys, 2)
      await drag(`[data-tab="${central.id}"]`, '#inspector-panel .sidebar-group-heading', .5)
      assert(await js(`window.__fixedInput===document.querySelector(${JSON.stringify(input)})`))
      await drag(`[data-tool-id="${fixedReader}"] [role=tab]`, '.editor-group', .5)
      central = (await snapshot()).tabs.find((t:any)=>t.type==='workspace.tool' && t.params.toolId===fixedReader)
      await activate(reader)
      await drag(`${context(reader)} [data-context-tool="demo-tools.reading"]`, '.editor-group', .5)
      assert(await js(`window.__fixedInput===document.querySelector(${JSON.stringify(input)})`), '从智能组重复拖出仍复用中央实例')
      assert.equal((await snapshot()).tabs.filter((t:any)=>t.type==='workspace.tool' && t.params.toolId===fixedReader).length, 1)
      assert(!(await snapshot()).sidebars.containers.some((c:any)=>c.views.includes(fixedReader)), '固定实例不能同时拥有两处位置')
      assert.equal(Object.keys((await snapshot()).sidebars.bindings).length, 2)
      await shot('context-tools-center.png')
      // 窗口命令不将普通工具位置当成素材收录页。
      await click('[aria-label="打开命令面板"]')
      await until(`!!document.querySelector('.command-palette')`)
      await js(`(() => {const el=document.querySelector('.command-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'导入文件');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await until(`document.querySelector('.command-palette')?.textContent.includes('请在素材视图中收录或新建内容')`)
      await js(`document.querySelector('.command-palette').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await until(`!document.querySelector('.command-palette')`)
      const textsBefore = (await call('query', { has: ['text'] })).ids
      await click('[data-quick-action="host.library.create-text"]')
      await until(`!!document.querySelector('.tab-pane:not(.hidden) .reader-editor')`)
      const createdText = (await call('query', { has: ['text'] })).ids.filter((id:string)=>!textsBefore.includes(id))
      assert.equal(createdText.length, 1, '中央工具焦点下仍可在仓库新建文字')
      await activate(central.id)
      // 普通工具移动、关闭再重开不复制状态；重新打开回默认侧栏。
      await executeUiCommand(js, 'host.tool.demo-tools.draft'); await wait()
      await js(`(() => { const el=document.querySelector('[aria-label="布局测试草稿"]');window.__draftNode=el;window.__draftInstance=el.parentElement.dataset.demoInstance;window.__draftScroll=el.parentElement;el.parentElement.scrollTop=100;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'跨区草稿');el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await drag('[data-tool-id="demo-tools.draft"] [role=tab]', '.editor-group', .5)
      const draftTab = (await snapshot()).tabs.find((t:any)=>t.type==='workspace.tool' && t.params.toolId==='demo-tools.draft')
      assert(draftTab)
      assert(await js(`window.__draftNode===document.querySelector('[aria-label="布局测试草稿"]')`))
      assert.equal(await js(`window.__draftScroll.scrollTop`), 100)
      await click(`[data-tab="${draftTab.id}"] .tab-x`); await executeUiCommand(js, 'host.tool.demo-tools.draft'); await wait()
      assert.equal(await js(`document.querySelector('[aria-label="布局测试草稿"]').value`), '跨区草稿')
      assert.equal(await js(`document.querySelector('[aria-label="布局测试草稿"]').parentElement.dataset.demoInstance`), await js('window.__draftInstance'))
      await activate(central.id)
      // 来源离开最近页面缓存后仍可操作，不能因后台冻结丢失固定工具能力。
      for (let i=0;i<9;i++) await click('.tab-new')
      await activate(central.id)
      await click(`[data-panel-content="${fixedReader}"] [data-context-add]`)
      assert.equal(await js(`document.querySelector('[data-panel-content="${fixedReader}"] [data-context-count]').textContent`), '3')
      await click(`[data-tab="${a}"] .tab-x`)
      await until(`document.querySelector('[data-panel-content="${fixedFilter}"] .context-tool-empty')?.textContent==='目标页面已关闭'`)
      assert.equal((await snapshot()).sidebars.bindings[fixedFilter].pageId, a)
      await activate(b); await click(`${context(b)} [data-context-tool="demo-tools.summary"]`)

      assert(await js(`!!document.querySelector('#inspector-panel ${context(b)}')`))
      await shot('context-tools-active.png')
      writeFileSync(join(dir, 'context-tools-saved.json'), JSON.stringify(await snapshot()))
    }
    writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
  } finally { await js('MessagePort.prototype.postMessage=window.__postMessage;void 0'); win.webContents.debugger.removeListener('message', intercepted); win.webContents.debugger.detach() }
}
