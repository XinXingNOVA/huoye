import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
import sharp from 'sharp'
import { imagePdf } from '../helpers/image-pdf'
interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string | readonly string[]): void; readMenu(): readonly ({ label: string } | { type: 'separator' })[] }
/** 从标签发起原生拖动，让 Chromium 在实际显示的正文上命中四个落点。 */
async function dragActiveTabToEdge(win: BrowserWindow, js: Tools['js'], dropEdge: 'right' | 'bottom') {
  const dbg = win.webContents.debugger
  const tab = await js(`(() => {
    const el = document.querySelector('[data-editor-group] [role=tab][aria-selected=true]')
    const r = el.getBoundingClientRect()
    return { id: el.dataset.tab, x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  const r = await js("document.querySelector('[data-editor-group] .tab-stack').getBoundingClientRect().toJSON()")
  const centerX = r.left + r.width / 2, centerY = r.top + r.height / 2
  const points = {
    left: { x: r.left + 12, y: centerY }, right: { x: r.right - 12, y: centerY },
    top: { x: centerX, y: r.top + 12 }, bottom: { x: centerX, y: r.bottom - 12 }
  }
  let data: { items: unknown[]; dragOperationsMask: number } | undefined
  const intercepted = (_event: Electron.Event, method: string, params: Record<string, any>) => {
    if (method === 'Input.dragIntercepted') data = params.data
  }
  const mouse = (type: string, x: number, y: number, buttons: number) =>
    dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, buttons, button: buttons || type === 'mouseReleased' ? 'left' : 'none', clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 })
  dbg.on('message', intercepted)
  await dbg.sendCommand('Input.setInterceptDrags', {enabled:true})
  try {
    await mouse('mouseMoved', tab.x, tab.y, 0)
    await mouse('mousePressed', tab.x, tab.y, 1)
    for (const offset of [8, 16, 24]) await mouse('mouseMoved', tab.x + offset, tab.y + offset, 1)
    for (let n = 0; !data && n < 60; n++) await new Promise(resolve => setTimeout(resolve, 25))
    assert(data, 'Chromium 未从中央标签启动拖动')
    await dbg.sendCommand('Input.dispatchDragEvent', {type:'dragEnter', ...points.left, data})
    for (const edge of ['left', 'top', 'right', 'bottom', dropEdge] as const) {
      await dbg.sendCommand('Input.dispatchDragEvent', {type:'dragOver', ...points[edge], data})
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await js("document.querySelector('.editor-drop-preview:not(.blocked)')?.dataset.edge"), edge, '内容区应按指针位置预览 ' + edge)
    }
    await dbg.sendCommand('Input.dispatchDragEvent', {type:'drop', ...points[dropEdge], data})
    await mouse('mouseReleased', points[dropEdge].x, points[dropEdge].y, 0)
    return tab.id as string
  } finally {
    dbg.off('message', intercepted)
    await dbg.sendCommand('Input.setInterceptDrags', {enabled:false})
  }
}
export async function editorLayoutFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu, readMenu }: Tools) {
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const mouse = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const menu = async (choice: string | readonly string[], selector = '.editor-group[data-focused=true] .editor-layout-button') => { chooseMenu(choice); await click(selector) }
  const menuLabels = () => readMenu().flatMap(item => 'label' in item ? item.label : [])
  const group = (index: number) => `.editor-group:nth-of-type(${index + 1})`
  const currentPage = (index: number) => `${group(index)} .tab-pane:not(.hidden)`
  const page = (name: string) => `[data-demo-page="${name}"]`
  const snapshot = () => js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`)
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const chooseTab = async (name: string) => { await js(`[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes(${JSON.stringify(name)})).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const openDemo = async (name: string) => { await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开示例 ${name}').click()`); await until(`!!document.querySelector('${page(name)}')`) }
  const moveTab = async (name: string, target?: string) => { chooseMenu(target ? ['移动到其他区域…', target] : '移动到另一个区域'); await js(`[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes(${JSON.stringify(name)})).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await wait() }
  await until(`!!document.querySelector('.editor-group .grid-scroller') || !!document.querySelector('[data-demo-page]')`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  try {
    if (process.env.CAPTURE_FLOW === 'editorlayoutresume') {
      const previous = JSON.parse(readFileSync(join(dir, 'editors-saved.json'), 'utf8'))
      assert.deepEqual((await snapshot()).editors, previous.editors)
      assert(await js(`document.querySelector('${page('A')} textarea').value==='右侧草稿' && document.querySelector('${page('B')} textarea').value==='左侧草稿'`))
      assert.equal(await js(`document.querySelectorAll('.tab-pane:not(.hidden)').length`), 3)
      await shot('editors-restart.png')
    } else {
      await menu('取消菜单')
      assert.deepEqual(menuLabels(), ['向右分屏', '向下分屏'])
      // 操作区与侧栏首组头部共用 44px 顶栏垂直中心，新建按钮与标签共用视觉中心；点击范围独立保持 28px。
      assert(await js(`(()=>{const header=document.querySelector('.window-toolbar'),hr=header.getBoundingClientRect(),hy=hr.top+hr.height/2,tab=header.querySelector('.tab'),r=tab.getBoundingClientRect(),ty=r.top+r.height/2;return [...header.querySelectorAll('.editor-layout-button,.panel-toggle,.tab-new')].every(el=>{const b=el.getBoundingClientRect(),icon=el.querySelector('svg').getBoundingClientRect(),y=el.classList.contains('tab-new')?ty:hy;return Math.abs(b.top+b.height/2-y)<1&&b.width>=28&&b.height>=28&&icon.width===16&&icon.height===16})&&header.querySelector('.tab-type-icon').getBoundingClientRect().width===16})()`), '顶栏图标尺寸或视觉中心未对齐')
      await shot('editors-header.png')
      const paths = ['A.md', 'B.md'].map(name => { const path = join(dir, name); writeFileSync(path, `# ${name}\n分屏测试 ${name}`); return path })
      const pdf = join(dir, '对照.pdf')
      writeFileSync(pdf, imagePdf(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#4455aa' } }).jpeg().toBuffer(), 80, 60))
      const routed = join(dir, '布局路由示例.txt'); writeFileSync(routed, '回调打开示例')
      const ids = await call('ingest', [...paths, pdf, routed].map(path => ({ type: 'file' as const, path })))
      await until(`!!document.querySelector('[data-entity-id="${ids[0]}"]')`)
      const openOther = async (id: string) => {
        chooseMenu('在另一组打开')
        await js(`document.querySelector('${currentPage(0)} [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
      }
      // 同一区域内，分别从 PDF 和仅剩一个标签的图库正文上实际拖出新区域。
      await js(`document.querySelector('[data-entity-id="${ids[2]}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
      await until("!!document.querySelector('.pdf-viewer')")
      const draggedPdf = await dragActiveTabToEdge(win, js, 'right')
      await until(`!!document.querySelector('${group(1)} [data-tab="${draggedPdf}"]')`)
      await click(`[data-tab="${draggedPdf}"] .tab-x`)
      await until("document.querySelectorAll('[data-editor-group]').length === 1")
      const draggedGrid = await dragActiveTabToEdge(win, js, 'bottom')
      await until(`!!document.querySelector('${group(1)} [data-tab="${draggedGrid}"]')`)
      assert(await js(`!!document.querySelector('${group(0)} .editor-start')`))
      await click(`${group(0)} [role=tab] .tab-x`)
      await until("document.querySelectorAll('[data-editor-group]').length === 1")
      await openOther(ids[2])
      await until(`!!document.querySelector('${group(1)} .pdf-viewer')`)
      // 已有页面在目标组：重复请求不新增标签，也不因右组获焦点反转目标。
      const pdfTab = await js(`document.querySelector('.pdf-viewer').closest('[data-tab-content]').dataset.tabContent`)
      await openOther(ids[2]); await wait(300)
      assert.equal(await js(`document.querySelectorAll('.pdf-viewer').length`), 1)
      assert(await js(`!!document.querySelector('${group(1)} [data-tab-content="${pdfTab}"]')`))
      await menu('取消菜单')
      assert.deepEqual(menuLabels().filter(label => !label.endsWith('分屏')), ['均分大小', '合并为一个区域'])
      assert(menuLabels().length <= 4)
      await click(`${group(1)} .tab-new`)
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 2)
      await until(`document.querySelectorAll('.tab-pane:not(.hidden) .grid-scroller').length===2`)
      assert(await js(`(()=>{const a=document.querySelectorAll('.editor-group');return a[0].getBoundingClientRect().height>100&&a[1].getBoundingClientRect().height>100&&Math.abs(a[0].getBoundingClientRect().top-a[1].getBoundingClientRect().top)<2})()`))
      assert(await js(`[...document.querySelectorAll('.tab-pane:not(.hidden) .grid-width-probe')].every(el=>Math.abs(el.getBoundingClientRect().width-el.closest('.tab-stack').clientWidth)<3)`), '瀑布流未使用所属组宽度')
      await mouse(`${currentPage(0)} [data-entity-id="${ids[0]}"]`)
      await until(`document.querySelector('.inspector').textContent.includes('A.md')`)
      await mouse(`${currentPage(1)} [data-entity-id="${ids[1]}"]`)
      await until(`document.querySelector('.inspector').textContent.includes('B.md')`)
      win.webContents.send('menu:command', 'find'); await wait()
      assert(await js(`document.activeElement.closest('[data-editor-group]')===document.querySelectorAll('.editor-group')[1]`))
      await mouse(`${currentPage(0)} [data-entity-id="${ids[0]}"]`)
      win.webContents.send('menu:command', 'find'); await wait()
      assert(await js(`document.activeElement.closest('[data-editor-group]')===document.querySelectorAll('.editor-group')[0]`))
      // 回调式打开器延迟调用 openData，也要继承菜单来源和另一组目标。
      await openOther(ids[3]); await mouse(currentPage(1))
      await until(`!!document.querySelector('${group(1)} .data-tab')`)
      await js(`[...document.querySelectorAll('${group(1)} .tab')].find(el=>el.textContent.includes('全部')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait()
      // PDF 在另一组可见但未获操作焦点，仍完成定位和绘制。
      await js(`document.querySelector('${currentPage(1)} [data-entity-id="${ids[2]}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
      await mouse(`${currentPage(0)} [data-entity-id="${ids[0]}"]`)
      await until(`!!document.querySelector('${currentPage(1)} .pdf-page canvas')`)
      await shot('editors-library.png')
      await click('[data-quick-action="demo-tools.open-status"]')
      await openDemo('A')
      await js(`(()=>{const el=document.querySelector('${page('A')} textarea');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'右侧草稿');el.dispatchEvent(new Event('input',{bubbles:true}));window.__editorInput=el;window.__editorInstance=el.parentElement.dataset.demoPageInstance;el.parentElement.scrollTop=100;window.__editorScroll=el.parentElement.scrollTop})()`)
      await wait()
      // 异步页面内打开仍归发起它的组。
      await click(`${page('A')} button`)
      await mouse(currentPage(1))
      await until(`!!document.querySelector('${group(0)} ${page('延迟')}')`)
      await chooseTab('示例 A')
      await click(`${page('A')} [data-open-other-self]`)
      assert(await js(`!!document.querySelector('${group(1)} ${page('A')}')`))
      assert(await js(`window.__editorInput===document.querySelector('${page('A')} textarea')&&window.__editorInstance===document.querySelector('${page('A')}').dataset.demoPageInstance&&window.__editorScroll===document.querySelector('${page('A')}').scrollTop`), '移组重建输入或丢失滚动')
      await mouse(currentPage(0)); await openDemo('B')
      await js(`(()=>{const el=document.querySelector('${page('B')} textarea');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'左侧草稿');el.dispatchEvent(new Event('input',{bubbles:true}));el.blur()})()`)
      await mouse(page('B'))
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}))`); await wait()
      assert(await js(`document.querySelector('${page('B')} [data-key-count]').textContent==='1'&&document.querySelector('${page('A')} [data-key-count]').textContent==='0'`))
      assert(await js(`document.querySelector('${page('A')}').dataset.visible==='true'&&document.querySelector('${page('A')}').dataset.active==='false'`))
      await mouse(page('A')); await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}))`); await wait()
      assert(await js(`document.querySelector('${page('A')} [data-key-count]').textContent==='1'`))
      // 关闭另组后台标签，不因关闭按钮获得焦点而切换操作组。
      await js(`(()=>{const close=[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes('示例 延迟')).querySelector('button');close.focus();close.click()})()`); await wait()
      assert(await js(`document.querySelector('${page('A')}').dataset.active==='true'`))
      await shot('editors-columns.png')
      // 标签 DOM 拖放跨组，仍保留原实例。
      await js(`(()=>{const a=[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes('示例 A')),b=[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes('示例 B')),dataTransfer=new DataTransfer();a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));b.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));b.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));a.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}))})()`)
      await wait(); assert(await js(`!!document.querySelector('${group(0)} ${page('A')}')`))
      const rightBefore = await js(`(()=>{const r=document.querySelector('${group(1)}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
      // 菜单向下局部分割左区域，右侧矩形保持。
      await menu('向下分屏', `${group(0)} .editor-layout-button`)
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 3)
      assert.deepEqual(await js(`(()=>{const r=document.querySelector('${group(2)}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`), rightBefore)
      assert(await js(`!!document.querySelector('${group(1)} .editor-start')`))
      // 把 A 拖到右区域下缘：先显示预览，松开后形成四区域。
      await js(`(()=>{window.__areaDrag=new DataTransfer();const a=[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes('示例 A'));a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__areaDrag}));const target=document.querySelector('${group(2)} .tab-stack'),r=target.getBoundingClientRect();window.__areaPoint={clientX:r.left+r.width/2,clientY:r.bottom-10};target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__areaDrag,...window.__areaPoint}))})()`); await wait()
      assert(await js(`!!document.querySelector('.editor-drop-preview[data-edge=bottom]:not(.blocked)')`))
      await js(`document.querySelector('${group(2)} .tab-stack').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__areaDrag,...window.__areaPoint}))`); await wait()
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 4)
      assert(await js(`window.__editorInput===document.querySelector('${page('A')} textarea')`))
      assert.equal(await js(`document.querySelectorAll('.editor-drop-preview').length`), 0)
      await shot('editors-four-areas.png')
      const countBefore = await js(`document.querySelectorAll('.editor-group').length`)
      await menu('向右分屏', `${group(0)} .editor-layout-button`)
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), countBefore, '窄区域不应继续横分')
      await js(`document.querySelector('.editor-resize[data-direction=rows]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`); await wait()
      assert.equal(await js(`document.querySelector('.editor-resize[data-direction=rows]').getAttribute('aria-valuenow')`), '55')
      await menu('均分大小')
      assert.equal(await js(`document.querySelector('.editor-resize[data-direction=rows]').getAttribute('aria-valuenow')`), '50')
      await moveTab('示例 B', '区域 3')
      assert(await js(`!!document.querySelector('${group(2)} ${page('B')}')`))
      await moveTab('示例 B', '区域 1')
      await mouse(page('A'))
      await menu(['合并当前区域…', '取消菜单'])
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 4)
      await menu(['合并当前区域…', '区域 1'])
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 3)
      assert(await js(`window.__editorInput===document.querySelector('${page('A')} textarea')`))
      // 关闭唯一的开始页，空区域连同冗余分割节点一起收起。
      await js(`[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes('开始')).querySelector('.tab-x').click()`); await wait()
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 2)
      await menu('合并为一个区域')
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 1)
      await menu('向右分屏'); await moveTab('示例 A'); await chooseTab('示例 B')
      // 存档保留嵌套三区域，重启不能退回旧两组模型。
      await menu('向下分屏', `${group(0)} .editor-layout-button`)
      await chooseTab('示例 B')
      await wait(650)
      writeFileSync(join(dir, 'editors-saved.json'), JSON.stringify(await snapshot()))
    }
    writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
  } finally { win.webContents.debugger.detach() }
}
