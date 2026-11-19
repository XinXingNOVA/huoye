import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { prepareWindow, resumeWindow } from '../../src/main/page-lifecycle'
import type { CoreApi } from '../../src/shared/rpc'
interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function sharedEditingFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu }: Tools) {
  const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const snapshot = async () => { await wait(600); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const pane = (id: string) => `[data-tab-content="${id}"]`
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const input = async (selector: string, value: string) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const activate = async (id: string) => { await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const button = async (id: string, title: string) => { await js(`[...document.querySelectorAll('${pane(id)} button')].find(b=>b.textContent===${JSON.stringify(title)}).click()`); await wait() }
  await until(`!!document.querySelector('.editor-group')`)
  if (process.env.CAPTURE_FLOW === 'sharededitingresume') {
    const { id, b } = JSON.parse(readFileSync(join(dir, 'editing-expected.json'), 'utf8'))
    await until(`document.querySelector('${pane(b)} textarea')?.value === 'final text'`)
    assert.equal((await call('get', [id]))[0].blocks.text.data.content, 'final text')
    await shot('shared-editing-resume.png')
  } else {
    const id = await call('create', { text: { content: 'original text' } })
    const collection = (await snapshot()).active
    await until(`!!document.querySelector('[data-entity-id="${id}"]')`)
    await js(`document.querySelector('[data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
    const a = (await snapshot()).active
    await button(a, '编辑')
    chooseMenu('在另一组新建此内容的视图')
    await js(`document.querySelector('[data-tab="${a}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
    const b = (await snapshot()).active
    await until(`!!document.querySelector('${pane(b)} textarea')`)
    await js(`(()=>{const el=document.querySelector('${pane(a)} textarea');el.focus();el.setSelectionRange(2,2);document.dispatchEvent(new Event('selectionchange'))})()`)
    const editorTop = () => js(`document.querySelector('${pane(b)} textarea').getBoundingClientRect().top`)
    const stableTop = await editorTop()
    assert.equal(await js(`document.querySelectorAll('.text-draft-status').length`), 0)
    await input(`${pane(b)} textarea`, 'shared draft')
    await until(`document.querySelector('${pane(b)} textarea')?.value==='shared draft'`)
    assert.equal(await js(`document.querySelector('${pane(a)} textarea').selectionStart`), 2, '另一视图保留自己的光标')
    await js(`document.querySelector('${pane(b)} textarea').focus()`)
    // 隔离验证窗口不争抢桌面焦点，直接发送原生菜单使用的同一 IPC。
    win.webContents.send('menu:command', 'undo'); await wait()
    assert.equal(await js(`document.querySelector('${pane(a)} textarea').value`), 'original text')
    win.webContents.send('menu:command', 'redo'); await wait()
    assert.equal(await editorTop(), stableTop)
    assert.equal(await js(`document.querySelectorAll('.text-draft-status').length`), 0)
    await wait(1000)
    assert.equal((await call('get', [id]))[0].blocks.text.data.content, 'shared draft')
    assert.equal(await editorTop(), stableTop)
    assert.equal(await js(`document.querySelectorAll('.text-draft-status').length`), 0)
    // Chromium 实际 beforeinput/input 与输入法组合事件；不把一次确认拆成候选字串。
    await activate(b)
    const caretEnd = () => js(`(()=>{const el=document.querySelector('${pane(b)} textarea');el.focus();el.setSelectionRange(el.value.length,el.value.length)})()`)
    const history = async (command: 'undo' | 'redo') => { win.webContents.send('menu:command', command); await wait() }
    const text = () => js(`document.querySelector('${pane(b)} textarea').value`)
    win.webContents.debugger.attach('1.3')
    try {
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      await caretEnd()
      for (const char of ['a', 'b', 'c']) await win.webContents.debugger.sendCommand('Input.insertText', { text: char })
      await history('undo'); assert.equal(await text(), 'shared draft', '连续输入应整体撤销')
      await history('redo'); assert.equal(await text(), 'shared draftabc')
      await caretEnd()
      await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
      await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
      await wait(1000)
      assert(['shared draft', 'shared draftabc'].includes(String((await call('get', [id]))[0].blocks.text.data.content)), '输入法组合过程不自动保存候选字串')
      await win.webContents.debugger.sendCommand('Input.insertText', { text: '你' })
      await history('undo'); assert.equal(await text(), 'shared draftabc', '一次中文确认整体撤销')
      await history('redo'); assert.equal(await text(), 'shared draftabc你')
      await history('undo'); await history('undo'); assert.equal(await text(), 'shared draft')
    } finally { win.webContents.debugger.detach() }
    // 详情栏同一草稿，不能靠失焦覆盖另一个输入框。
    await until(`!!document.querySelector('#inspector-panel textarea')`)
    await input('#inspector-panel textarea', 'inspector draft')
    await until(`document.querySelector('${pane(a)} textarea')?.value==='inspector draft'`)
    await wait(950)
    // 后台修改冲突：先输入，再在自动保存前模拟 MCP/其他插件写入。
    await input(`${pane(b)} textarea`, 'keep my draft')
    await call('put', id, 'text', { content: 'external text' })
    await until(`document.querySelector('${pane(b)}')?.textContent.includes('草稿与仓库内容冲突')`)
    assert.equal(await editorTop(), stableTop, '异常提示也不能挤动正文')
    await click(`${pane(b)} .text-draft-status > summary`)
    assert.equal(await editorTop(), stableTop, '展开处理也不能挤动正文')
    await shot('shared-editing-conflict.png')
    await click(`[data-tab="${b}"] .tab-x`)
    assert((await snapshot()).tabs.some((t: any) => t.id === b), '冲突必须保留页面')
    await assert.rejects(prepareWindow(win, 'reload'), /冲突/); resumeWindow(win)
    // 模拟异常 renderer 重启；从工作区快照找回草稿，不能覆盖权威数据。
    await snapshot()
    win.webContents.forcefullyCrashRenderer(); await wait(250); win.webContents.reload(); await wait(1000)
    await until(`document.querySelector('${pane(b)} textarea')?.value==='keep my draft'`)
    await until(`document.querySelector('${pane(b)}')?.textContent.includes('草稿与仓库内容冲突')`)
    assert.equal((await call('get', [id]))[0].blocks.text.data.content, 'external text')
    await click(`${pane(b)} .text-draft-status > summary`)
    await button(b, '保留草稿，替换已查看的版本'); await wait(950)
    assert.equal((await call('get', [id]))[0].blocks.text.data.content, 'keep my draft')
    // 关闭一个投影后另一页仍编辑；仓库撤销能同步回干净草稿。
    await click(`[data-tab="${a}"] .tab-x`)
    await input(`${pane(b)} textarea`, 'before reload'); await wait(950)
    await call('undo'); await until(`document.querySelector('${pane(b)} textarea')?.value==='keep my draft'`)
    await call('redo'); await until(`document.querySelector('${pane(b)} textarea')?.value==='before reload'`)
    await input(`${pane(b)} textarea`, 'final text')
    await reloadLibrary(libraryOf(win.webContents)!)
    await until(`document.querySelector('${pane(b)} textarea')?.value==='final text'`)
    assert.equal((await call('get', [id]))[0].blocks.text.data.content, 'final text')
    // 文件只允许一个编辑者，另一个阅读视图不会创建第二份发布草稿。
    const path = join(dir, 'versioned.md'); writeFileSync(path, 'file original')
    const [file] = await call('ingest', [{ type: 'file', path }])
    await activate(collection); await until(`!!document.querySelector('${pane(collection)} [data-entity-id="${file}"]')`)
    await js(`document.querySelector('${pane(collection)} [data-entity-id="${file}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
    const fa = (await snapshot()).active
    await until(`!!document.querySelector('${pane(fa)} .reader-doc')`); await button(fa, '编辑')
    chooseMenu('在另一组新建此内容的视图'); await js(`document.querySelector('[data-tab="${fa}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
    const fb = (await snapshot()).active
    await until(`document.querySelector('${pane(fb)}')?.textContent.includes('正在另一视图中编辑')`)
    await button(fa, '完成'); await until(`!!document.querySelector('${pane(fb)} textarea')`)
    await click(`[data-tab="${fa}"] .tab-x`); await click(`[data-tab="${fb}"] .tab-x`)
    await activate(b)
    writeFileSync(join(dir, 'editing-expected.json'), JSON.stringify({ id, b }))
    await shot('shared-editing.png')
  }
  writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
}
