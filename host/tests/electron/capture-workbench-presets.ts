import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'

interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function workbenchPresetsFlow(win: BrowserWindow, dir: string, { js: evaluate, shot, chooseMenu }: Tools) {
  const js = async (code: string) => { try { return await evaluate(code) } catch (error) { throw new Error(`预设界面脚本失败：${code}`, { cause: error }) } }
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const nativeClick = async (selector: string) => {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
    await wait()
  }
  const key = async (keyCode: string) => {
    win.webContents.sendInputEvent({type:'keyDown',keyCode})
    win.webContents.sendInputEvent({type:'keyUp',keyCode})
    await wait()
  }
  const menu = async (label: string) => {
    if (!await js(`!!document.querySelector('.workbench-control-popover')`)) await nativeClick('[aria-label="工作台布局"]')
    await until(`!!document.querySelector('.workbench-control-popover')`)
    const text = label === '将当前布局另存为…' ? '+ 保存当前布局…' : label === '返回切换前布局' ? '↩ 返回切换前' : label
    assert(await js(`(()=>{const b=[...document.querySelectorAll('.workbench-control-popover button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.querySelector('strong')?.textContent===${JSON.stringify(text)}||b.querySelector('.wb-pop-preset-title')?.textContent===${JSON.stringify(text)});if(!b)return false;b.dataset.captureAction='true';return true})()`), label)
    await nativeClick('[data-capture-action="true"]')
    await js(`document.querySelector('[data-capture-action]')?.removeAttribute('data-capture-action')`)
    if (await js(`!!document.querySelector('.workbench-control-popover')`)) await key('Escape')
  }
  const text = async (selector: string, value: string) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await wait()
  }
  const button = async (scope: string, label: string) => { await js(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent===${JSON.stringify(label)}).click()`); await wait() }
  const libraryId = libraryOf(win.webContents)!.id
  const storageKey = `rm:workbench-presets:${libraryId}`
  const catalog = () => js(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`)
  const snapshot = () => js(`window.bridge.loadWorkspace(${JSON.stringify(libraryId)})`)
  const save = async (name: string) => {
    await menu('将当前布局另存为…'); await text('#workbench-preset-name', name)
    await button('.workbench-presets', '保存布局'); await click('[aria-label="关闭布局预设"]')
  }
  await until(`!!document.querySelector('.editor-group')`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  try {
    if (process.env.CAPTURE_FLOW === 'workbenchpresets') {
      // 原生点击与程序点击走同一个浮层；键盘不能穿透到页面或窗口。
      await nativeClick('[aria-label="工作台布局"]')
      assert(await js(`document.querySelector('.workbench-control-popover').contains(document.activeElement)`))
      await js(`window.__escapedKeys=[];window.__keyProbe=e=>window.__escapedKeys.push(e.key);window.addEventListener('keydown',window.__keyProbe)`)
      await key('a'); await key('Delete')
      await js(`[...document.querySelectorAll('.workbench-control-popover button')].at(-1).focus()`)
      await key('Tab')
      assert(await js(`document.querySelector('.workbench-control-popover').contains(document.activeElement)`))
      await key('Escape')
      assert.deepEqual(await js(`window.__escapedKeys`),[])
      assert(await js(`document.activeElement===document.querySelector('[aria-label="工作台布局"]')`))
      await js(`window.removeEventListener('keydown',window.__keyProbe)`)
      await click('[aria-label="工作台布局"]')
      assert(await js(`!!document.querySelector('.workbench-control-popover')`))
      await shot('workbench-control-popover.png')
      await key('Escape')
    }
    if ((process.env.CAPTURE_FLOW ?? '').startsWith('workbenchpresetcontents')) {
      const savedPath = join(dir, 'preset-contents-saved.json')
      const row = '[data-demo-preset="demo-presets.organize"]'
      if (process.env.CAPTURE_FLOW === 'workbenchpresetcontentsresume') {
        const expected = JSON.parse(readFileSync(savedPath, 'utf8'))
        const w = await snapshot(), all = w.tabs.find((t: any) => t.id === expected.all)
        assert.equal(all.state.search, '切换后的搜索')
        assert.equal(all.state.layouts.masonry.zoom, 200, '重启采用最新呈现，不重放旧预设')
        assert.equal(w.tabs.filter((t: any) => t.type === 'file-spaces').length, 1)
        assert.deepEqual(await catalog(), expected.catalog)
        await shot('workbench-content-resume.png')
      } else {
        await until(`!!document.querySelector('.search-input')`)
        await js(`globalThis.collectionElement=document.querySelector('.search-input').closest('[data-tab-content]');void 0`)
        const all = await js(`collectionElement.dataset.tabContent`)
        const pane = `[data-tab-content="${all}"]`
        const zoom = async (value: number) => {
          await click(pane + ' .display-menu > button')
          await text('.display-panel input[type="range"]', String(value))
          await click(pane + ' .display-menu > button')
        }
        await text(pane + ' .search-input', '切换前的搜索'); await zoom(180)
        await click('[data-quick-action="demo-tools.open-status"]'); await button('.tool-view-content', '打开示例 A')
        await text('[data-demo-page="A"] textarea', '预设不应改写的草稿')
        await js(`globalThis.draftElement=document.querySelector('[data-demo-page="A"]');void 0`)
        // 使用已有标签头把操作焦点放回集合。
        await js(`document.querySelector('[data-tab="${all}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait()
        await menu('管理布局预设…'); await until(`!!document.querySelector('${row}')`)
        await button(row, '应用'); await wait(700)
        let w = await snapshot()
        assert.equal(w.active, all)
        assert.equal(w.tabs.filter((t: any) => t.type === 'file-spaces').length, 1)
        assert.equal(w.tabs.find((t: any) => t.id === all).state.layouts.masonry.zoom, 340)
        assert.equal(await js(`document.querySelector('${pane} .search-input').value`), '切换前的搜索')
        assert(await js(`document.querySelector('${pane}')===collectionElement`), '编排不重建原集合')
        assert(await js(`document.querySelector('[data-demo-page="A"]')===draftElement`), '保活草稿不重建')
        const tabIds = w.tabs.map((t: any) => t.id).sort()
        // 返回点只记一次切换；先验证返回，再重新应用两次验证幂等。
        await button('[data-preset-demo]', '关闭')
        await text(pane + ' .search-input', '切换后的搜索')
        await menu('返回切换前布局'); await wait(700)
        w = await snapshot()
        assert.equal(w.tabs.find((t: any) => t.id === all).state.layouts.masonry.zoom, 180)
        assert.equal(w.tabs.find((t: any) => t.id === all).state.presentation, undefined, '返回恢复默认呈现继承，不留下修改标记')
        assert.equal(await js(`document.querySelector('${pane} .search-input').value`), '切换后的搜索')
        assert.equal(w.tabs.find((t: any) => t.type === 'demo-tools.page').state.draft, '预设不应改写的草稿')
        await menu('素材与空间对照'); await menu('素材与空间对照'); await wait(650)
        assert.deepEqual((await snapshot()).tabs.map((t: any) => t.id).sort(), tabIds)
        await zoom(200)
        await menu('将当前布局另存为…'); await until(`!!document.querySelector('[data-preset-demo]')`)
        await text('[aria-label="示例预设名称"]', '我的内容编排')
        await button('[data-preset-demo]', '保存当前布局')
        const captured = await catalog(), encoded = JSON.stringify(captured)
        assert(encoded.includes('file-spaces') && encoded.includes('"contents"'))
        assert(!encoded.includes('预设不应改写的草稿') && !encoded.includes('切换后的搜索'))
        await shot('workbench-content-applied.png')
        await button('[data-preset-demo]', '关闭'); await wait(650)
        writeFileSync(savedPath, JSON.stringify({ all, catalog: captured }))
      }
    } else if ((process.env.CAPTURE_FLOW ?? '').startsWith('workbenchpresetapi')) {
      const row = '[data-demo-preset="demo-presets.reading"]'
      const savedPath = join(dir, 'preset-api-saved.json')
      if (process.env.CAPTURE_FLOW === 'workbenchpresetapi') {
        await click('[data-quick-action="demo-tools.open-status"]'); await button('.tool-view-content', '打开示例 A')
        await text('[data-demo-page="A"] textarea', '插件切换仍保留的输入')
        await js(`globalThis.apiPage=document.querySelector('[data-demo-page="A"]');void 0`)
        const groups = await js(`document.querySelectorAll('.editor-group').length`)
        await menu('管理布局预设…'); await until(`!!document.querySelector('[data-preset-demo]')`)
        assert.equal(await js(`document.querySelectorAll('.editor-group').length`), groups, '读取与绘制预览不能应用布局')
        assert(await js(`!!document.querySelector('[data-demo-preset="host.focus"] [role="img"]') && !!document.querySelector('${row} [role="img"]')`), '界面通过公共服务读取其他来源的预设')
        await text('[aria-label="示例预设名称"]', '我的阅读副本'); await button(row, '另存副本')
        const copy = (await catalog()).presets[0]
        await until(`!!document.querySelector('[data-demo-preset="${copy.id}"]')`)
        await button(row, '应用')
        assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 3)
        assert(await js(`document.querySelector('[data-demo-page="A"]')===apiPage`))
        await button('[data-preset-demo]', '返回切换前布局')
        assert.equal(await js(`document.querySelectorAll('.editor-group').length`), groups)
        await button(`[data-demo-preset="${copy.id}"]`, '应用')
        await shot('preset-api-preview.png')
        await button('[data-preset-demo]', '演示界面故障')
        await until(`!!document.querySelector('.workbench-presets')`)
        assert(await js(`document.querySelector('.export-dialog').textContent.includes('已使用基础界面')`))
        assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 3)
        await click('[data-layout-preset="demo-presets.organize"]')
        assert(await js(`document.querySelector('.workbench-preset-preview').textContent.includes('文件空间') && document.querySelector('.workbench-preset-preview').textContent.includes('瀑布流')`))
        assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 3, '内容预览不改变当前布局')
        assert(!(await snapshot()).tabs.some((t: any) => t.type === 'file-spaces'), '内容预览不打开页面')
        assert(await js(`(()=>{const r=document.querySelector('.export-dialog').getBoundingClientRect();return r.bottom<=innerHeight && r.right<=innerWidth})()`), '包含故障说明时窗口仍应完整可见')
        await shot('preset-api-fallback.png')
        await click('[aria-label="关闭布局预设"]')
        await wait(650)
        writeFileSync(savedPath, JSON.stringify({ catalog: await catalog(), editors: (await snapshot()).editors }))
      } else {
        const expected = JSON.parse(readFileSync(savedPath, 'utf8'))
        assert.deepEqual(await catalog(), expected.catalog)
        assert.deepEqual((await snapshot()).editors, expected.editors)
        await until(`!!document.querySelector('[data-demo-page="A"] textarea')`)
        assert.equal(await js(`document.querySelector('[data-demo-page="A"] textarea').value`), '插件切换仍保留的输入')
        await menu('管理布局预设…')
        if (process.env.CAPTURE_FLOW === 'workbenchpresetapimissing') {
          assert(!(await js(`!!document.querySelector('[data-preset-demo]')`)))
          assert(await js(`document.querySelector('.workbench-presets').textContent.includes('1 项内容暂不可用')`))
          assert(!(await js(`!!document.querySelector('[data-layout-preset="demo-presets.reading"]')`)))
          await click(`[data-layout-preset="${expected.catalog.presets[0].id}"]`)
          assert(await js(`document.querySelector('.preset-preview-issues').textContent.includes('未启用')`))
          await shot('preset-api-disabled.png')
          await click('[aria-label="关闭布局预设"]')
          await menu('我的阅读副本')
          assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 3)
          await wait(650)
          writeFileSync(savedPath, JSON.stringify({ catalog: await catalog(), editors: (await snapshot()).editors }))
        } else {
          assert(await js(`!!document.querySelector('${row}')`))
          const copyId = expected.catalog.presets[0].id
          assert(!(await js(`document.querySelector('[data-demo-preset="${copyId}"]').textContent.includes('暂不可用')`)))
          await shot('preset-api-restored.png')
          await button('[data-preset-demo]', '关闭')
        }
      }
    } else if (process.env.CAPTURE_FLOW === 'workbenchpresetsresume') {
      const expected = JSON.parse(readFileSync(join(dir, 'presets-saved.json'), 'utf8'))
      assert.deepEqual(await catalog(), expected.catalog)
      assert.deepEqual((await snapshot()).editors, expected.workspace.editors)
      await until(`!!document.querySelector('[data-demo-page="A"] textarea')`)
      assert.equal(await js(`document.querySelector('[data-demo-page="A"] textarea').value`), '切换后继续编辑')
      await menu('研究布局')
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 2)
      await menu('管理布局预设…')
      assert(await js(`document.querySelector('.workbench-presets').textContent.includes('研究布局')`))
      await shot('workbench-presets-restart.png')
      await click('[aria-label="关闭布局预设"]')
    } else {
      await click('[data-quick-action="demo-tools.open-status"]')
      await button('.tool-view-content', '打开示例 A')
      await until(`!!document.querySelector('[data-demo-page="A"] textarea')`)
      await text('[data-demo-page="A"] textarea', '布局之外的草稿 A')
      chooseMenu('向右分屏'); await click('.editor-group[data-focused=true] .editor-layout-button')
      await button('.tool-view-content', '打开示例 B')
      await until(`!!document.querySelector('[data-demo-page="B"] textarea')`)
      await text('[data-demo-page="B"] textarea', '布局之外的草稿 B')
      await click('[data-demo-page="A"] [data-prevent-leave]')
      await js(`globalThis.presetPageA=document.querySelector('[data-demo-page="A"]');globalThis.presetPageB=document.querySelector('[data-demo-page="B"]');void 0`)
      const original = await js(`[...document.querySelectorAll('[data-demo-page]')].map(el=>({name:el.dataset.demoPage,group:el.closest('[data-editor-group]').dataset.editorGroup}))`)
      await save('我的对照')
      assert.equal((await catalog()).presets.length, 1)
      assert(!JSON.stringify(await catalog()).includes('草稿 A'))
      await menu('管理布局预设…')
      await click('[data-layout-preset="host.focus"]')
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 2, '选择预览不应用')
      assert(await js(`document.querySelector('.preset-diagram').getAttribute('aria-label').includes('左栏收起')`))
      assert(!(await js(`[...document.querySelectorAll('.workbench-preset-detail button')].some(b=>b.textContent==='删除')`)), '原版只读')
      await button('.workbench-preset-detail', '应用预设')
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 1)
      assert(await js(`document.querySelector('[data-demo-page="A"]')===presetPageA && document.querySelector('[data-demo-page="B"]')===presetPageB`), '仅调整布局不应重建仍保活的页面')
      assert.equal(await js(`document.querySelector('[data-demo-page="A"] textarea').value`), '布局之外的草稿 A')
      assert.equal(await js(`document.querySelector('#sidebar-panel').getAttribute('aria-hidden')`), 'true')
      assert.equal((await catalog()).presets[0].layout.panels.sidebar, true, '临时切换不得改写预设')
      await menu('返回切换前布局')
      assert.deepEqual(await js(`[...document.querySelectorAll('[data-demo-page]')].map(el=>({name:el.dataset.demoPage,group:el.closest('[data-editor-group]').dataset.editorGroup}))`), original)
      await text('[data-demo-page="A"] textarea', '切换后继续编辑')
      await click('[data-demo-page="A"] [data-prevent-leave]') // 正常退出允许保存，布局切换期间没有结束页面。
      await menu('对照')
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 2)
      await menu('管理布局预设…')
      const own = (await catalog()).presets[0].id
      await click(`[data-layout-preset="${own}"]`)
      await button('.workbench-preset-detail', '重命名'); await text('#workbench-preset-name', '研究布局'); await button('.workbench-presets', '保存名称')
      await button('.workbench-preset-detail', '更新为当前布局'); await button('.workbench-preset-confirm', '更新布局')
      assert.equal((await catalog()).presets[0].title, '研究布局')
      assert.equal((await catalog()).presets[0].layout.panels.sidebar, false)
      await text('[aria-label="搜索预设"]', '研究')
      assert.equal(await js(`document.querySelectorAll('[data-layout-preset]').length`), 1)
      await text('[aria-label="搜索预设"]', '')
      await button('.workbench-preset-detail', '另存副本')
      await text('#workbench-preset-name', '研究布局')
      assert(await js(`document.querySelector('#workbench-preset-name').getAttribute('aria-invalid')==='true' && document.querySelector('.workbench-preset-form [type="submit"]').disabled`))
      await button('.workbench-preset-form', '取消')
      await shot('workbench-presets-manager.png')
      const size = win.getSize()
      win.setSize(800, 600); await wait(300)
      await button('.workbench-presets', '保存当前布局…')
      await text('#workbench-preset-name', '窄窗口检查')
      assert(await js(`(()=>{const panel=document.querySelector('.workbench-presets'),r=panel.getBoundingClientRect();return r.right<=innerWidth && r.bottom<=innerHeight && panel.scrollWidth<=panel.clientWidth+1})()`), '窄窗口预设管理不应溢出')
      await shot('workbench-presets-narrow.png')
      win.setSize(size[0], size[1]); await wait(300)
      await click('[aria-label="关闭布局预设"]')
      await menu('管理布局预设…')
      await click('[data-layout-preset="host.organize"]')
      await button('.workbench-preset-detail', '另存副本'); await text('#workbench-preset-name', '临时布局'); await button('.workbench-presets', '保存布局')
      await click('[aria-label="关闭布局预设"]')
      await menu('管理布局预设…')
      const temporary = (await catalog()).presets.find((p: { title: string }) => p.title === '临时布局').id
      await click(`[data-layout-preset="${temporary}"]`); await button('.workbench-preset-detail', '删除'); await button('.workbench-preset-confirm', '删除预设')
      assert.equal((await catalog()).presets.length, 1)
      assert.equal(await js(`document.querySelectorAll('.editor-group').length`), 2)
      await click('[aria-label="关闭布局预设"]')
      // 模拟持久化失败：表单报错、已保存条目不变，窗口仍可关闭。
      await js(`globalThis.savedSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===${JSON.stringify(storageKey)})throw new Error('模拟写入失败');return savedSetItem.call(this,k,v)};void 0`)
      await menu('将当前布局另存为…'); await text('#workbench-preset-name', '不应保存'); await button('.workbench-presets', '保存布局')
      assert(await js(`document.querySelector('[role="alert"]').textContent.includes('模拟写入失败')`))
      assert.equal((await catalog()).presets.length, 1)
      await js(`Storage.prototype.setItem=savedSetItem;void 0`)
      await click('[aria-label="关闭布局预设"]')
      // 最终打开两个已有页；重启同时验证页面状态和独立预设列表。
      await menu('返回切换前布局')
      await wait(650)
      writeFileSync(join(dir, 'presets-saved.json'), JSON.stringify({ catalog: await catalog(), workspace: await snapshot() }))
      await shot('workbench-presets-applied.png')
    }
    writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
  } finally { win.webContents.debugger.detach() }
}
