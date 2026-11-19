import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
import sharp from 'sharp'
import { imagePdf } from '../helpers/image-pdf'

interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void }
export async function pageInstancesFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu }: Tools) {
  const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const activate = async (id: string) => { await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const pane = (id: string) => `[data-tab-content="${id}"]`
  const snapshot = async () => { await wait(600); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const duplicate = async (id: string) => { chooseMenu('在另一组新建此内容的视图'); await js(`document.querySelector('[data-tab="${id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); return (await snapshot()).active as string }
  const close = (id: string) => click(`[data-tab="${id}"] .tab-x`)
  const jump = async (id: string, n: number) => {
    await activate(id); await until(`!!document.querySelector('${pane(id)} .pdf-page canvas')`)
    await click(`${pane(id)} .pdf-page-jump`)
    await js(`(()=>{const el=document.querySelector('${pane(id)} input[aria-label="跳转页码"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'${n}');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await js(`document.querySelector('${pane(id)} input[aria-label="跳转页码"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
    await until(`document.querySelector('${pane(id)} .pdf-page-jump')?.textContent.includes('${n} /')`)
    await wait(650)
  }
  await until(`!!document.querySelector('.editor-group')`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  try {
    if (process.env.CAPTURE_FLOW === 'pageinstancesresume') {
      const expected = JSON.parse(readFileSync(join(dir, 'page-instances-expected.json'), 'utf8'))
      const w = await snapshot()
      for (const entry of expected.tabs) assert.deepEqual(w.tabs.find((t: any) => t.id === entry.id)?.state, entry.state)
      assert.equal(w.tabs.filter((t: any) => t.type === 'pdf.viewer').length, 2)
      assert.equal(w.tabs.filter((t: any) => t.type === 'image.viewer').length, 2)
      await shot('page-instances-resume.png')
    } else {
      const picture = join(dir, '对照.png'), pdf = join(dir, '阅读.pdf')
      await sharp({ create: { width: 600, height: 400, channels: 3, background: '#4477aa' } }).png().toFile(picture)
      writeFileSync(pdf, imagePdf(await sharp(picture).jpeg().toBuffer(), 600, 400, 4))
      const [book, image] = await call('ingest', [pdf, picture].map(path => ({ type: 'file', path })))
      await call('put', book, 'pdfreading', { page: 1, offset: 0, lastRead: 1 })
      const collection = (await snapshot()).tabs.find((t: any) => t.type === 'collection').id
      const open = async (asset: string) => {
        await activate(collection); await until(`!!document.querySelector('${pane(collection)} [data-entity-id="${asset}"]')`)
        await js(`document.querySelector('${pane(collection)} [data-entity-id="${asset}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
        return (await snapshot()).active as string
      }
      const a = await open(book); await jump(a, 2)
      const b = await duplicate(a)
      assert.notEqual(a, b)
      await until(`document.querySelectorAll('.pdf-viewer').length===2`)
      assert.equal((await snapshot()).tabs.find((t: any) => t.id === b).state.page, 2)
      await jump(b, 4)
      assert.equal((await snapshot()).tabs.find((t: any) => t.id === a).state.page, 2)
      assert.equal((await call('get', [book]))[0].blocks.pdfreading.data.page, 1, '多视图阅读期间仍不写仓库')
      const reused = await open(book)
      assert([a, b].includes(reused)); assert.equal((await snapshot()).tabs.filter((t: any) => t.type === 'pdf.viewer').length, 2)
      await close(a); await wait(350)
      assert.equal((await call('get', [book]))[0].blocks.pdfreading.data.page, 4, '关闭旧视图应采用仍打开的较新阅读位置')
      await close(b); await wait(350)
      assert.equal((await call('get', [book]))[0].blocks.pdfreading.data.page, 4)
      const c = await open(book); await jump(c, 2)
      const d = await duplicate(c); await jump(d, 3)
      await close(d); await wait(350); await close(c); await wait(350)
      assert.equal((await call('get', [book]))[0].blocks.pdfreading.data.page, 3, '反向关闭顺序不得覆盖已保存的新进度')
      const left = await open(book); await jump(left, 2)
      const right = await duplicate(left); await jump(right, 4)
      const picA = await open(image)
      await until(`!!document.querySelector('${pane(picA)} .viewer-image img')`)
      await click(`${pane(picA)} button[title="原始大小（1）"]`)
      const picB = await duplicate(picA)
      await until(`!!document.querySelector('${pane(picB)} .viewer-image img')`)
      await click(`${pane(picB)} button[aria-label="放大图片"]`)
      await js(`document.querySelector('${pane(picB)} .viewer-stage').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaX:25,deltaY:30}))`)
      const pics = (await snapshot()).tabs.filter((t: any) => t.type === 'image.viewer')
      assert.equal(pics.find((t: any) => t.id === picA).state.zoom, 1)
      assert.equal(pics.find((t: any) => t.id === picB).state.zoom, 1.25)
      assert.notDeepEqual(pics[0].state.pan, pics[1].state.pan)
      // 外部声明：每份内容最多两页，默认打开复用本页；导航与新建共享数量约束。
      await click('[data-quick-action="demo-tools.open-status"]')
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开多视图示例').click()`)
      const first = (await snapshot()).active
      await click(`${pane(first)} [data-new-view]`)
      const second = (await snapshot()).active
      assert.notEqual(first, second)
      await click(`${pane(second)} [data-local-add]`); await click(`${pane(second)} [data-reuse-view]`)
      assert.equal((await snapshot()).active, second)
      await click(`${pane(second)} [data-new-view]`)
      assert.equal((await snapshot()).tabs.filter((t: any) => t.type === 'demo-tools.limited').length, 2)
      assert(await js(`document.body.textContent.includes('最多打开 2 个视图')`))
      await click(`${pane(second)} [data-other-content]`)
      const third = (await snapshot()).active
      await click(`${pane(third)} [data-navigate-a]`)
      assert.equal((await snapshot()).tabs.find((t: any) => t.id === third).params.name, 'B')
      await close(first); await activate(third); await click(`${pane(third)} [data-navigate-a]`)
      assert.equal((await snapshot()).tabs.find((t: any) => t.id === third).params.name, 'A')
      await click(`${pane(third)} [data-single-new]`)
      assert.equal((await snapshot()).tabs.filter((t: any) => t.type === 'demo-tools.single').length, 0)
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开单例示例').click()`)
      const singleton = (await snapshot()).active
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开单例示例').click()`)
      assert.equal((await snapshot()).active, singleton)
      await click(`${pane(singleton)} [data-single-new]`)
      assert.equal((await snapshot()).tabs.filter((t: any) => t.type === 'demo-tools.single').length, 1)
      // 同内容的多个存档经过宿主重载与下一进程启动都保留；图片缩放、PDF 页码互不覆盖。
      await activate(left); await activate(right)
      const before = (await snapshot()).tabs.filter((t: any) => ['pdf.viewer', 'image.viewer'].includes(t.type))
      await reloadLibrary(libraryOf(win.webContents)!)
      await until(`!!document.querySelector('.pdf-viewer .pdf-page canvas')`)
      const after = await snapshot()
      for (const entry of before) assert.deepEqual(after.tabs.find((t: any) => t.id === entry.id)?.state, entry.state)
      writeFileSync(join(dir, 'page-instances-expected.json'), JSON.stringify({ tabs: before }))
      await shot('page-instances.png')
    }
    writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
  } finally { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach() }
}
