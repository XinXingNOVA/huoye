import { once } from 'node:events'
import assert from 'node:assert/strict'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { prepareWindow, resumeWindow } from '../../src/main/page-lifecycle'
import { callCore } from '../../src/main/core-client'
import type { CoreApi } from '../../src/shared/rpc'
import sharp from 'sharp'
import { imagePdf } from '../helpers/image-pdf'

interface Tools { js(code: string): Promise<any>; shot(name: string): Promise<void> }
export async function pageLifecycleFlow(win: BrowserWindow, dir: string, { js, shot }: Tools) {
  const wait = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait() } throw new Error(`界面未就绪：${code}`) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const activate = async (name: string) => { await js(`[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes(${JSON.stringify(name)})).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait() }
  const close = async (name: string) => { await js(`[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes(${JSON.stringify(name)})).querySelector('.tab-x').click()`); await wait(250) }
  const snapshot = () => js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`)
  const position = async (id: string) => (await call('get', [id]))[0].blocks.pdfreading?.data
  const jump = async (n: number) => {
    await click('.tab-pane:not(.hidden) .pdf-page-jump')
    await js(`(()=>{const el=document.querySelector('input[aria-label="跳转页码"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(n))});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await js(`document.querySelector('input[aria-label="跳转页码"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
    await until(`document.querySelector('.tab-pane:not(.hidden) .pdf-page-jump')?.textContent.includes('${n} /')`)
    await wait(650)
  }
  const readyPdf = () => until(`!!document.querySelector('.tab-pane:not(.hidden) .pdf-page canvas')`)
  await until(`!!document.querySelector('.editor-group')`)
  if (process.env.CAPTURE_FLOW === 'pagelifecycleresume') {
    const { id, tab } = JSON.parse(readFileSync(join(dir, 'page-lifecycle-expected.json'), 'utf8'))
    assert.equal((await position(id))?.page, 3, '正常退出未写回最终进度')
    await readyPdf()
    assert.equal((await snapshot()).tabs.find((t: any) => t.id === tab).state.page, 3)
    assert.equal(await js(`document.querySelector('.tab-pane:not(.hidden) .pdf-viewer').dataset.paper`), 'warm')
    await shot('page-lifecycle-resume.png')
  } else {
    const paths = []
    for (const [name, color] of [['A.pdf', '#884444'], ['B.pdf', '#448844']]) {
      const path = join(dir, name)
      writeFileSync(path, imagePdf(await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toBuffer(), 80, 60, 4))
      paths.push(path)
    }
    const ids = await call('ingest', paths.map(path => ({ type: 'file', path })))
    await call('put', ids[0], 'pdfreading', { page: 1, offset: 0, lastRead: 1 })
    await until(`!!document.querySelector('[data-entity-id="${ids[0]}"]')`)
    const openPdf = async (id: string) => {
      await activate('全部')
      await js(`document.querySelector('.tab-pane:not(.hidden) [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`)
      await readyPdf()
    }
    await openPdf(ids[0]); await jump(3)
    assert.equal((await position(ids[0]))?.page, 1, '阅读期间不应不断写仓库进度')
    const pdfTab = (await snapshot()).tabs.find((t: any) => t.type === 'pdf.viewer').id
    await openPdf(ids[0])
    assert.equal(await js(`document.querySelectorAll('.pdf-viewer').length`), 1)
    assert.equal((await snapshot()).tabs.find((t: any) => t.id === pdfTab).state.page, 3)
    // 超过后台保活数量，组件卸载；仍只保留本机状态，不写仓库。
    for (let i = 0; i < 4; i++) { await click('.tab-new') }
    await until(`!document.querySelector('.pdf-viewer')`)
    assert.equal((await position(ids[0]))?.page, 1)
    await close('A.pdf')
    assert.equal((await position(ids[0]))?.page, 3, '冻结页面没有通过静态回调保存')
    await openPdf(ids[0]); await jump(2)
    // 真正的本机落盘失败：失败时保留标签和内容，恢复目录后重试。
    const folder = join(app.getPath('userData'), 'workspaces'), backup = folder + '-held'
    renameSync(folder, backup); writeFileSync(folder, 'blocked')
    try {
      await close('A.pdf')
      assert(await js(`!!document.querySelector('.pdf-viewer')`))
      assert.equal((await position(ids[0]))?.page, 3)
    } finally { rmSync(folder); renameSync(backup, folder) }
    await close('A.pdf'); assert.equal((await position(ids[0]))?.page, 2)
    await openPdf(ids[0]); await jump(4)
    // 同标签切换另一篇：先保存旧文档，再切换，不把旧页码赋给新文档。
    await click('.tab-pane:not(.hidden) .pdf-queue button:not(:disabled)')
    await until(`document.querySelector('.tab.active')?.textContent.includes('B.pdf')`)
    assert.equal((await position(ids[0]))?.page, 4)
    await readyPdf(); await close('B.pdf'); await openPdf(ids[0]); await jump(2)
    await reloadLibrary(libraryOf(win.webContents)!)
    await until(`!!document.querySelector('.editor-group')`); await readyPdf()
    assert.equal((await position(ids[0]))?.page, 2)
    // Chromium 自带重载也必须经过收尾；被取消的 beforeunload 不能提前销毁缓存连接。
    await jump(3); await js(`window.__oldPage=true`)
    // Chromium 仅在真实用户激活后允许 beforeunload 阻止导航。
    await win.webContents.executeJavaScript('void 0', true)
    assert(await js(`navigator.userActivation.hasBeenActive`))
    win.webContents.reload()
    await wait(1000); await until(`!window.__oldPage && !!document.querySelector('.editor-group')`); await readyPdf()
    assert.equal((await position(ids[0]))?.page, 3)
    await jump(2)
    // 模拟渲染进程意外退出，不触发结束回调：从本机快照恢复，优先于旧仓库进度。
    win.webContents.forcefullyCrashRenderer(); await wait(250); win.webContents.reload()
    await wait(1000); await until(`!!document.querySelector('.editor-group')`); await readyPdf()
    assert.equal((await position(ids[0]))?.page, 3)
    assert.equal((await snapshot()).tabs.find((t: any) => t.type === 'pdf.viewer').state.page, 2)
    // 核心离线不能把重新加载入口锁死；恢复时保留页面快照，不伪称已写回。
    const offline = libraryOf(win.webContents)!, exited = once(offline.core, 'exit')
    offline.core.kill(); await exited
    await reloadLibrary(offline)
    await until(`!!document.querySelector('.editor-group')`); await readyPdf()
    assert.equal((await position(ids[0]))?.page, 3)
    assert.equal((await snapshot()).tabs.find((t: any) => t.type === 'pdf.viewer').state.page, 2)
    // 外部示例插件的结束回调拒绝；关标签和整窗准备都保持页面，取消后正常重试。
    await click('[data-quick-action="demo-tools.open-status"]')
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开示例 A').click()`)
    await until(`!!document.querySelector('[data-prevent-leave]')`); await click('[data-prevent-leave]')
    await close('示例 A'); assert(await js(`!!document.querySelector('[data-demo-page="A"]')`))
    await assert.rejects(prepareWindow(win, 'reload'), /暂未允许结束/)
    resumeWindow(win); await wait()
    await click('[data-prevent-leave]'); await close('示例 A')
    await activate('A.pdf'); await readyPdf(); await jump(3)
    await click('.tab-pane:not(.hidden) .pdf-paper')
    await until(`document.querySelector('.tab-pane:not(.hidden) .pdf-viewer').dataset.paper==='warm'`)
    const tab = (await snapshot()).tabs.find((t: any) => t.type === 'pdf.viewer').id
    assert.equal((await position(ids[0]))?.page, 2, '退出前应保持上一次已写入的进度')
    writeFileSync(join(dir, 'page-lifecycle-expected.json'), JSON.stringify({ id: ids[0], tab }))
    await shot('page-lifecycle-before-quit.png')
  }
  writeFileSync(join(dir, `${process.env.CAPTURE_FLOW}-result.json`), JSON.stringify({ ok: true }))
  if (process.env.CAPTURE_FLOW === 'pagelifecycle') { const closed = once(win, 'closed'); win.close(); await closed }
}
