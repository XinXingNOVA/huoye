import { executeUiCommand } from './capture-command'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'

interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function sidebarLayoutFlow(win: BrowserWindow, dir: string, { js: execute, shot, chooseMenu }: Tools) {
  const js = async (code: string) => { try { return await execute(code) } catch (error) { throw new Error(`侧栏验证脚本失败：${code}`, { cause: error }) } }
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => {
    for (let i = 0; i < 80; i++) { if (await js(code)) return; await wait() }
    throw new Error(`界面未就绪：${code}`)
  }
  const tab = (id: string) => `[role="tab"][id="tool-tab-${encodeURIComponent(id)}"]`
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const menu = async (id: string, choice: string) => {
    chooseMenu(choice)
    await js(`document.querySelector(${JSON.stringify(tab(id))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
    await wait()
  }
  // 从鼠标按下启动 Chromium 的原生拖动，再接管落点；不能用 DOM dragstart 绕过启动阶段。
  let dragData: any, dropPoint = { x: 0, y: 0 }
  const mouse = (type: string, x: number, y: number, pressed = false) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: pressed || type === 'mouseReleased' ? 'left' : 'none', buttons: pressed ? 1 : 0, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 })
  const startDrag = async (id: string, group = false) => {
    dragData = undefined
    const source = await js(`(() => {
      const tab=document.querySelector(${JSON.stringify(tab(id))}), el=${group ? "tab.closest('.sidebar-group').querySelector('.sidebar-group-grip')" : "tab"};
      el.scrollIntoView({block:'nearest',inline:'nearest'});
      const r=el.getBoundingClientRect(), clip=el.closest('.sidebar-tabs')?.getBoundingClientRect();
      const left=clip?Math.max(r.left,clip.left):r.left, right=clip?Math.min(r.right,clip.right):r.right;
      return {x:(left+right)/2,y:r.top+r.height/2};
    })()`)
    await mouse('mouseMoved', source.x, source.y)
    await mouse('mousePressed', source.x, source.y, true)
    await mouse('mouseMoved', source.x + 8, source.y + 8, true)
    await mouse('mouseMoved', source.x + 16, source.y + 16, true)
    for (let i = 0; i < 20 && !dragData; i++) await wait(50)
    assert(dragData, '鼠标未能从标签／组按钮启动浏览器拖动：' + JSON.stringify(await js('window.__dragTrace')))
    await until(`!!document.querySelector('.sidebar-layout-drop-layer')`)
  }
  const hover = async (side: string, target: string, at: 'header' | 'top' | 'bottom' | 'center') => {
    dropPoint = await js(`(() => {
      const tab=document.querySelector(${JSON.stringify(tab(target))}), group=tab.closest('.sidebar-group');
      if(${at === 'header'}) tab.scrollIntoView({block:'nearest',inline:'nearest'});
      const r=group.getBoundingClientRect(), h=group.querySelector('.sidebar-group-heading').getBoundingClientRect();
      const b=tab.getBoundingClientRect(), clip=tab.closest('.sidebar-tabs').getBoundingClientRect();
      return {x:${at === 'header' ? 'Math.max(b.left,clip.left)+3' : 'r.left+r.width/2'},y:${at === 'header' ? 'h.top+h.height/2' : `h.bottom+(r.bottom-h.bottom)*${at === 'top' ? '.15' : at === 'bottom' ? '.85' : '.5'}`}};
    })()`)
    await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragEnter', ...dropPoint, data:dragData})
    await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragOver', ...dropPoint, data:dragData})
    await wait()
    assert(await js(`!!document.querySelector('.dock-${side} .sidebar-layout-drop-preview')`), '真实鼠标拖动没有命中预览：' + JSON.stringify(await js('window.__dragTrace')))
  }
  const drop = async () => {
    await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'drop', ...dropPoint, data:dragData})
    await mouse('mouseReleased', dropPoint.x, dropPoint.y)
    await wait()
  }
  const snapshot = () => js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`)
  await until(`!!document.querySelector('.sidebar-groups')`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await win.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
  const intercepted = (_event: Electron.Event, method: string, params: any) => { if (method === 'Input.dragIntercepted') dragData = params.data }
  win.webContents.debugger.on('message', intercepted)
  await js(`window.__dragTrace=[]; for(const type of ['mousedown','dragstart','dragenter','dragover','drop','dragend','blur']) window.addEventListener(type,e=>window.__dragTrace.push({type,target:e.target?.outerHTML?.slice(0,180),trusted:e.isTrusted,layer:!!document.querySelector('.sidebar-layout-drop-layer')}),true)`)

  try {
    if (process.env.CAPTURE_FLOW === 'sidebarlayoutresume') {
      const previous = JSON.parse(readFileSync(join(dir, 'layout-saved.json'), 'utf8'))
      assert.deepEqual((await snapshot()).sidebars, previous.sidebars)
      assert.deepEqual((await snapshot()).panels, previous.panels)
      assert(!(await js(`!!document.querySelector(${JSON.stringify(tab('demo-tools.draft'))})`)))
      await executeUiCommand(js, 'host.tool.demo-tools.draft'); await wait()
      assert(await js(`!!document.querySelector('#sidebar-panel [data-demo-instance]')`))
      await shot('layout-restart.png')
    } else {
      assert.deepEqual(await js(readFileSync(join(dir, 'surface-slots-fixture.js'), 'utf8') + ';surfaceSlotCheck.verify()'), { ok: true })
      chooseMenu('关闭此组工具')
      await click('.sidebar-group[data-container-type="context"] .sidebar-group-menu')
      assert(await js(`!!document.querySelector('#sidebar-panel .sidebar') && !!document.querySelector('#inspector-panel .inspector')`))
      assert(!(await js(`!!document.querySelector('[data-demo-instance]')`)))
      assert(await js(`!document.querySelector('.app-titlebar') && !document.querySelector('.window-command-bar')`))
      const tops = await js(`[document.querySelector('#sidebar-panel .sidebar-group-heading'),document.querySelector('.window-toolbar'),document.querySelector('#inspector-panel .sidebar-group-heading')].map(e=>e.getBoundingClientRect().top)`)
      assert(tops.every((n: number) => Math.abs(n - tops[0]) < 1), '三段顶部没有对齐')
      assert(await js(`['.editor-group .tabbar','#inspector-panel .sidebar-tabs','.window-drag-space'].every(s=>getComputedStyle(document.querySelector(s)).getPropertyValue('-webkit-app-region')==='drag')`), '顶部空白必须可拖窗口')
      assert(await js(`['.tab','.sidebar-tab','.panel-toggle'].every(s=>getComputedStyle(document.querySelector(s)).getPropertyValue('-webkit-app-region')==='no-drag')`), '真实控件必须可交互')
      assert.deepEqual(await js(`[...document.querySelectorAll('.activity-items [data-quick-action]')].map(el=>el.dataset.quickAction)`), ['host.view.all', 'host.library.create-text', 'host.library.import', 'demo-tools.open-status'])
      assert.equal(await js(`document.querySelectorAll('.activity-items [aria-pressed]').length`), 0)
      await shot('layout-default.png')
      // 首组与窗口控制共享宽度；拖动排序时展开左栏，使源和目标图标同时可见。
      for (let i = 0; i < 10; i++) {
        await js(`document.querySelector('.panel-resize-left').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
        await wait(20)
      }
      await executeUiCommand(js, 'host.tool.demo-tools.draft'); await wait()
      await until(`!!document.querySelector('[aria-label="布局测试草稿"]')`)
      assert.equal((await snapshot()).sidebars.containers.find((c: any) => c.views.includes('demo-tools.draft'))?.id, 'default:demo-tools.draft', '无容器声明的工具由宿主安排独立默认组')
      await js(`(() => {
        const el=document.querySelector('[aria-label="布局测试草稿"]'); el.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'跨侧移动也保留的输入'); el.dispatchEvent(new Event('input',{bubbles:true}));
        window.__draftNode=el; window.__draftInstance=document.querySelector('[data-demo-instance]').dataset.demoInstance;
        const scroller=document.querySelector('[data-demo-instance]'); scroller.scrollTop=60; window.__draftScroll=scroller.scrollTop;
      })()`)
      await wait()
      await menu('demo-tools.draft', '加入「导航」')
      assert(await js(`!!document.querySelector('#sidebar-panel [data-demo-instance]') && window.__draftNode===document.querySelector('[aria-label="布局测试草稿"]') && window.__draftNode.value==='跨侧移动也保留的输入'`))
      assert(await js(`(() => { const e=document.querySelector('[data-demo-instance]'); return e.scrollTop===Math.min(window.__draftScroll,e.scrollHeight-e.clientHeight) })()`))
      // 同组切换保留原 DOM，另一侧仍然显示详情。
      await click(tab('host.navigation')); await click(tab('demo-tools.draft'))
      assert(await js(`document.querySelector('[data-demo-instance]').dataset.demoInstance===window.__draftInstance && !!document.querySelector('#inspector-panel .inspector')`))
      assert.equal(await js(`document.querySelectorAll('#sidebar-panel .sidebar-tool-label:not([hidden])').length`), 1, '同组只展开当前工具名')
      // 工具排序；正文上／下部是宽落点，中心合并；取消不改变组数。
      await startDrag('demo-tools.draft'); await hover('left', 'host.navigation', 'header'); await drop()
      assert.deepEqual(await js(`[...document.querySelectorAll('#sidebar-panel [role=tab]')].map(el=>el.getAttribute('aria-label'))`), ['草稿', '导航'])
      await startDrag('demo-tools.draft'); await hover('left', 'host.navigation', 'bottom')
      assert(await js(`document.querySelector('#sidebar-panel .sidebar-layout-drop-preview').dataset.edge==='bottom' && document.querySelector('#sidebar-panel .sidebar-layout-drop-preview').getBoundingClientRect().height>100`))
      assert.equal(await js(`document.querySelectorAll('#sidebar-panel .sidebar-group').length`), 1)
      await shot('layout-drop-bottom.png')
      // 已接管的浏览器拖动需由 CDP 取消，不能只发 DOM Escape 后遗留底层拖动。
      await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', {type:'dragCancel', ...dropPoint, data:dragData})
      await mouse('mouseReleased', dropPoint.x, dropPoint.y)
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await wait()
      assert(!(await js(`!!document.querySelector('.sidebar-layout-drop-layer')`)))
      assert.equal(await js(`document.querySelectorAll('#sidebar-panel .sidebar-group').length`), 1)
      await startDrag('demo-tools.draft'); await hover('left', 'host.navigation', 'bottom'); await drop()
      assert.equal(await js(`document.querySelectorAll('#sidebar-panel .sidebar-group').length`), 2)
      const previousRatio = await js(`Number(document.querySelector('#sidebar-panel .tool-view-resize').getAttribute('aria-valuenow'))`)
      await js(`document.querySelector('#sidebar-panel .tool-view-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`)
      await wait(); assert(await js(`Number(document.querySelector('#sidebar-panel .tool-view-resize').getAttribute('aria-valuenow'))>${previousRatio}`))
      // 整组跨侧：上半区、下半区均可命中。合并后再拖出仍保留原实例。
      await startDrag('demo-tools.draft', true); await hover('right', 'host.inspector', 'top'); await drop()
      assert(await js(`!!document.querySelector('#inspector-panel [data-demo-instance]')`))
      await startDrag('demo-tools.draft'); await hover('right', 'host.inspector', 'center'); await drop()
      assert.equal(await js(`document.querySelectorAll('#inspector-panel .sidebar-group').length`), 1)
      await startDrag('demo-tools.draft'); await hover('left', 'host.navigation', 'bottom'); await drop()
      assert(await js(`!!document.querySelector('#sidebar-panel [data-demo-instance]') && window.__draftNode===document.querySelector('[aria-label="布局测试草稿"]')`))
      // 独立组不对自己做无意义拆分。
      await startDrag('demo-tools.draft'); await hover('left', 'demo-tools.draft', 'bottom')
      assert(await js(`document.querySelector('#sidebar-panel .sidebar-layout-drop-preview').dataset.blocked==='true'`)); await drop()
      assert.equal(await js(`document.querySelectorAll('#sidebar-panel .sidebar-group').length`), 2)
      await shot('layout-groups.png')
      // 收起后开关合入中央，隐藏工具不抢键盘；重新展开保留输入与 DOM。
      await click('[aria-label="收起左侧栏"]'); await wait(350)
      assert(await js(`!!document.querySelector('.window-toolbar [aria-label="展开左侧栏"]') && document.querySelector('#sidebar-panel').inert`))
      await click('[aria-label="收起右侧栏"]'); await wait(350)
      assert.equal(await js(`document.querySelectorAll('.window-toolbar .panel-toggle').length`), 2)
      await shot('layout-collapsed.png')
      await click('[aria-label="展开左侧栏"]'); await click('[aria-label="展开右侧栏"]'); await wait(350)
      assert(await js(`window.__draftNode===document.querySelector('[aria-label="布局测试草稿"]') && window.__draftNode.value==='跨侧移动也保留的输入'`))
      // 原生命令菜单与鼠标入口都可唤起；关闭后回到工作区。
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] }); await until(`!!document.querySelector('.command-palette-input')`)
      await js(`document.querySelector('.command-palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await until(`!document.querySelector('.command-palette-input')`)
      // 关闭工具保留位置，快捷入口显式重新打开；原 showView 同样接续原位置。
      await menu('demo-tools.draft', '关闭此工具')
      await click('[data-quick-action="demo-tools.open-status"]')
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开草稿').click()`); await wait()
      assert(await js(`!!document.querySelector('#sidebar-panel [data-demo-instance]')`))
      await menu('demo-tools.draft', '关闭此工具')
      await wait(650)
      writeFileSync(join(dir, 'layout-saved.json'), JSON.stringify(await snapshot()))
      await shot('layout-saved.png')
    }
    writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
  } finally { win.webContents.debugger.removeListener('message', intercepted); win.webContents.debugger.detach() }
}
