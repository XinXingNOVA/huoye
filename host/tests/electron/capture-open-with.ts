import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shell, type BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { LibraryFiles } from '../../src/storage/library-files'

interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function openWithFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu }: Tools) {
  const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let n = 0; n < 100; n++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const library = libraryOf(win.webContents)!, file = join(dir, 'open-with-saved.json')
  const all = async () => { await js(`[...document.querySelectorAll('.tab')].find(t=>t.querySelector('.tab-title')?.textContent==='全部').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const picker = async (id: string) => {
    await all(); chooseMenu('打开方式…')
    await js(`document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`)
    await until(`!!document.querySelector('.open-with')`)
  }
  const select = async (id: string) => click(`.open-with input[value="${id}"]`)
  const submit = async () => { await click('.open-with button[type=submit]'); await until(`!document.querySelector('.open-with')`) }
  const openPath = shell.openPath
  const opened: string[] = []
  let failure = false
  shell.openPath = async path => { if (failure) return '测试：没有关联应用'; opened.push(path); return '' }
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  try {
    await until(`!!document.querySelector('.grid-scroller')`)
    if (process.env.CAPTURE_FLOW === 'openwithresume') {
      const { id } = JSON.parse(readFileSync(file, 'utf8'))
      await picker(id)
      assert(await js(`document.querySelector('.open-with input[value="text.reader"]').checked`), '默认方式未随本机仓库恢复')
      await click('.open-with button[type=button]')
      await js(`document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
      await until(`!!document.querySelector('.editor-group[data-focused=true] .tab-pane:not(.hidden) .reader')`)
      // 恢复自动后，优先级高的回调打开器再次生效。
      await picker(id); await select('host.auto')
      await click('.open-with .open-with-option:nth-of-type(2) input'); await submit()
      await until(`!!document.querySelector('.editor-group[data-focused=true] .tab-pane:not(.hidden) .data-tab')`)
      await picker(id)
      assert(await js(`document.querySelector('.open-with input[value="host.auto"]').checked`))
      await click('.open-with button[type=button]')
      await shot('open-with-restart.png')
    } else {
      const path = join(dir, '布局路由示例.txt'); writeFileSync(path, '查看副本，不回写原件。')
      const [id] = await callCore(library.core, 'ingest', [{ type: 'file', path }])
      for (let n = 0; n < 100; n++) { if ((await callCore(library.core, 'get', [id]))[0]?.blocks.body) break; await wait() }
      await until(`!!document.querySelector('[data-entity-id="${id}"]')`)
      await picker(id)
      assert(await js(`document.querySelectorAll('.open-with input[name=opener]').length===5`), '应列出自动、两个匹配的打开器、详情、系统查看')
      await select('demo-tools.route'); await click('.open-with .open-with-option:nth-of-type(1) input')
      await shot('open-with-choices.png'); await submit()
      await until(`document.querySelectorAll('.editor-group').length===2 && !!document.querySelector('.editor-group:nth-of-type(2) .data-tab')`)
      await picker(id); await select('text.reader')
      await click('.open-with .open-with-option:nth-of-type(1) input')
      await click('.open-with .open-with-option:nth-of-type(2) input'); await submit()
      await until(`!!document.querySelector('.editor-group:nth-of-type(2) .reader')`)
      assert(await js(`!!document.querySelector('.editor-group:nth-of-type(1) .tab-pane:not(.hidden) .grid-scroller')`), '打开方式丢失来源分组')
      // 显式选择当前组时，将已有的同身份阅读页移到来源组，而不是跳往原来的另一组。
      await picker(id); await select('text.reader'); await submit()
      await until(`!!document.querySelector('.editor-group:nth-of-type(1) .tab-pane:not(.hidden) .reader')`)
      await picker(id); await select('host.system'); failure = true
      await click('.open-with button[type=submit]')
      await until(`document.querySelector('.open-with [role=alert]')?.textContent.includes('没有关联应用')`)
      failure = false; await submit()
      assert.equal(opened.length, 1)
      assert.equal(readFileSync(opened[0], 'utf8'), '查看副本，不回写原件。')
      writeFileSync(opened[0], '外部编辑')
      await js(`window.bridge.files.openCopy(${JSON.stringify(id)})`)
      assert.equal(opened.length, 2)
      assert.notEqual(opened[0], opened[1])
      assert.equal(readFileSync(opened[1], 'utf8'), '查看副本，不回写原件。')
      const [view] = await callCore(library.core, 'get', [id])
      assert.equal(readFileSync(new LibraryFiles(library.root).readable(String(view.blocks.file.data.path)), 'utf8'), '查看副本，不回写原件。')
      await all(); await wait(650)
      writeFileSync(file, JSON.stringify({ id }))
    }
    writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true, systemLaunch: 'stubbed', copies: opened.length }))
  } finally { shell.openPath = openPath; win.webContents.debugger.detach() }
}
