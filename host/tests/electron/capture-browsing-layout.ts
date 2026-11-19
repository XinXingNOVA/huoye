import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'

/** 使用真实外部表格／看板包；界面状态的恢复通过进程重启和停用／启用验证。 */
export async function browsingLayoutFlow(win: BrowserWindow, dir: string, chooseMenu: (label: string) => void) {
  const lib = libraryOf(win.webContents)!, js = (code: string): Promise<any> => win.webContents.executeJavaScript(code)
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error('界面未就绪：' + code) }
  const pane = '.tab-pane:not(.hidden)', display = '.display-panel'
  const click = async (selector: string) => { await until(`!!document.querySelector(${JSON.stringify(selector)})`); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const button = async (scope: string, text: string) => { await until(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`); await wait() }
  const change = async (selector: string, value: string, select = false) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}))})()`); await wait()
  }
  const menu = async () => { if (!await js(`!!document.querySelector(${JSON.stringify(display)})`)) await click(pane + ' [aria-label="显示设置"]') }
  const layout = async (value: string) => { await menu(); await change(display + ' [aria-label="浏览布局"]', value, true) }
  const dismiss = async () => { if (await js(`!!document.querySelector(${JSON.stringify(display)})`)) await click(pane + ' [aria-label="显示设置"]') }
  const scroll = async (selector: string, top: number) => { await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollTop=${top};e.dispatchEvent(new Event('scroll'))})()`); await wait(500) }
  const workspace = async () => { await wait(650); return js(`window.bridge.loadWorkspace(${JSON.stringify(lib.id)})`) }
  const position = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)})?.scrollTop`)
  const activate = async (id: string) => { await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait(250) }
  const boardColumn = pane + ' [data-drop-title="markdown"] .kanban-scroller'
  const resultFile = join(dir, `${process.env.CAPTURE_FLOW}-result.json`)
  try {
    await until(`!!document.querySelector(${JSON.stringify(pane + ' .collection')})`)
    if (process.env.CAPTURE_FLOW !== 'browsinglayout') {
      const expected = JSON.parse(readFileSync(join(dir, 'browsing-layout-saved.json'), 'utf8'))
      await activate(expected.tab)
      if (process.env.CAPTURE_FLOW === 'browsinglayoutmissing') {
        await until(`document.querySelector(${JSON.stringify(pane + ' .layout-unavailable')})?.textContent.includes('kanban')`)
        await menu(); await change(display + ' input[type="range"]', '330')
        const w = await workspace(), t = w.tabs.find((t: any) => t.id === expected.tab)
        assert.equal(t.params.layout, 'kanban'); assert.equal(t.params.options.groupBy, 'body.format')
        assert.equal(t.state.layouts.kanban.zoom, 300)
        assert.equal(t.state.layouts.masonry.zoom, 330)
        assert.equal(t.state.presentation, undefined, '调整临时回退不覆盖原选择')
        assert.equal(await js(`JSON.parse(localStorage.getItem('rm:browsing-default:${lib.id}')).presentation.layout`), 'kanban')
        await dismiss()
      } else {
        await until(`!!document.querySelector(${JSON.stringify(boardColumn)})`)
        assert(await position(boardColumn) > 900, '重启恢复看板列内锚点')
        await menu(); assert.equal(await js(`document.querySelector(${JSON.stringify(display + ' input[type="range"]')}).value`), '300')
        assert.equal(await js(`document.querySelector(${JSON.stringify(display + ' .layout-options select')}).value`), 'body.format')
        await layout('table'); assert(await position(pane + ' .table-scroller') >= 1100)
        assert.equal(await js(`document.querySelector(${JSON.stringify(display + ' input[type="range"]')})`), null)
        await layout('kanban'); await dismiss()
      }
      writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}.png`), (await win.webContents.capturePage()).toPNG())
      writeFileSync(resultFile, JSON.stringify({ ok: true })); return
    }

    const files = Array.from({ length: 90 }, (_, i) => {
      const path = join(dir, `布局素材-${String(i).padStart(3, '0')}.${i % 2 ? 'md' : 'txt'}`)
      writeFileSync(path, `# 布局测试 ${i}\n新导入的正文内容 ${i}`); return { type: 'file' as const, path }
    })
    const imported = await callCore(lib.core, 'importToLibrary', files, { requestId: 'browsing-layout-seed' })
    assert.equal(imported.errors.length, 0)
    for (let i = 0; i < 100; i++) { if ((await callCore(lib.core, 'get', imported.items.map(v => v.id))).every(v => v.blocks.body)) break; await wait() }
    assert((await callCore(lib.core, 'get', imported.items.map(v => v.id))).every(v => v.blocks.body), '真实 Electron 文字加工')
    await until(`document.querySelector(${JSON.stringify(pane + ' .toolbar-count')})?.textContent.trim()==='90 项'`)
    await menu(); await change(display + ' input[type="range"]', '260'); await dismiss()
    await scroll(pane + ' .grid-scroller', 1300)
    const firstState = await workspace(), tab = firstState.active, anchor = firstState.tabs.find((t: any) => t.id === tab).state.layouts.masonry.anchor
    assert(anchor)
    await layout('table'); assert.equal(await js(`document.querySelector(${JSON.stringify(display + ' input[type="range"]')})`), null)
    await dismiss(); await scroll(pane + ' .table-scroller', 1200)
    await layout('masonry'); assert.equal(await js(`document.querySelector(${JSON.stringify(display + ' input[type="range"]')}).value`), '260')
    await dismiss(); assert(await position(pane + ' .grid-scroller') > 900)
    await layout('table'); await dismiss(); assert(await position(pane + ' .table-scroller') >= 1100)
    // 集合仍统一管理多选；更换布局不丢选择。
    const selected = await js(`(()=>{const rows=[...document.querySelectorAll('${pane} .table-row')].slice(0,2);rows.forEach((e,i)=>e.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,metaKey:!!i})));return rows.map(e=>e.dataset.entityId)})()`)
    await wait()
    await layout('kanban'); await change(display + ' .layout-options select', 'body.format', true)
    await change(display + ' input[type="range"]', '300'); await dismiss()
    await until(`!!document.querySelector(${JSON.stringify(boardColumn)})`)
    await scroll(boardColumn, 1300)
    await layout('table'); await layout('kanban'); await dismiss()
    await until(`document.querySelector(${JSON.stringify(boardColumn)})?.scrollTop>900`)
    assert.deepEqual((await workspace()).tabs.find((t: any) => t.id === tab).state.selection.sort(), selected.sort())

    // 列内打开把视觉顺序传给阅读器，下一项不跨到其他列。
    await js(`document.querySelector('${boardColumn} [data-entity-id]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
    await until(`!!document.querySelector('.reader')`)
    const reader = (await workspace()).tabs.find((t: any) => t.type === 'text.reader')
    const columnIds = (await callCore(lib.core, 'query', { scope: 'content', role: 'material', where: [{ kind: 'body', field: 'format', op: 'eq', value: 'markdown' }] })).ids
    assert.deepEqual(reader.params.list.orderedIds, columnIds)
    await activate(tab)

    // 配置在保存视图对话框可编辑，分列选择写入视图，尺寸仍留本页。
    chooseMenu('另存为新视图…'); await click(pane + ' [aria-label="视图操作"]')
    await until("!!document.querySelector('dialog [aria-label=\"视图名称\"]')")
    await change('dialog [aria-label="视图名称"]', '看板布局验收')
    assert.equal(await js("document.querySelector('dialog .layout-options select').value"), 'body.format')
    await button('dialog', '保存视图'); await until("!document.querySelector('dialog')")
    const saved = (await workspace()).tabs.find((t: any) => t.id === tab)
    assert.equal(saved.params.layout, 'kanban'); assert.equal(saved.params.options.groupBy, 'body.format')
    assert.equal(((await callCore(lib.core, 'get', [saved.params.viewId]))[0].blocks.view.data.options as Record<string, unknown>).groupBy, 'body.format')

    await layout('table'); await button(display, '将当前显示设为默认'); await dismiss()
    win.webContents.send('menu:command', 'tab.new')
    await until(`!!document.querySelector(${JSON.stringify(pane + ' .table-scroller')})`)
    const newPage = await workspace(); assert.notEqual(newPage.active, tab)
    assert.equal(newPage.tabs.find((t: any) => t.id === newPage.active).state.initialPresentation.layout, 'table')
    await activate(tab); await layout('kanban'); await button(display, '将当前显示设为默认'); await dismiss()
    // 恢复保存规则，清除本页显示覆盖，原布局状态仍保留。
    chooseMenu('重置本页临时调整'); await click(pane + ' [aria-label="视图操作"]')
    await wait(300)
    const w = await workspace()
    assert.equal(w.tabs.find((t: any) => t.id === newPage.active).state.initialPresentation.layout, 'table', '改默认不影响已有页面')
    assert.equal(w.tabs.find((t: any) => t.id === tab).state.layouts.kanban.zoom, 300)
    await menu(); win.setSize(960, 760); await wait(300)
    const bounds = await js(`(()=>{const r=document.querySelector(${JSON.stringify(display)}).getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}})()`)
    assert(bounds.left >= 0 && bounds.right <= 960 && bounds.bottom <= 760)
    assert(await js(`(()=>{const el=document.querySelector('.display-panel'), r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+20,r.top+20))&&el.contains(document.elementFromPoint(r.right-20,r.bottom-20))})()`), '浮层不能被分屏容器裁切或遮挡')
    assert(await js(`(()=>{const panel=document.querySelector('.display-panel').getBoundingClientRect(), button=document.querySelector('${pane} [aria-label="显示设置"]').getBoundingClientRect();return panel.left<=button.right&&panel.right>=button.left&&Math.abs(panel.top-button.bottom)<=8})()`), '窗口换行后浮层继续跟随按钮')
    writeFileSync(join(dir, 'browsing-layout-display.png'), (await win.webContents.capturePage()).toPNG())
    await dismiss()
    writeFileSync(join(dir, 'browsing-layout-saved.json'), JSON.stringify({ tab, newTab: newPage.active }))
    await workspace()
    writeFileSync(resultFile, JSON.stringify({ ok: true, checks: ['外部包', '新文件加工', '独立尺寸与滚动', '选择保持', '看板配置', '保存规则', '默认范围', '窄窗口'] }))
  } catch (e) {
    writeFileSync(join(dir, 'browsing-layout-error.txt'), String(e) + '\n' + await js('document.body.innerText'))
    writeFileSync(join(dir, 'browsing-layout-error.png'), (await win.webContents.capturePage()).toPNG()); throw e
  }
}
