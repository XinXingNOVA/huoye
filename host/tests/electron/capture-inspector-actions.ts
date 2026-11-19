import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BrowserWindow } from 'electron'
import type { CoreApi } from '../../src/shared/rpc'
import { callCore } from '../../src/main/core-client'
import { libraryOf } from '../../src/main/libraries'
import { imagePdf } from '../helpers/image-pdf'
import { executeUiCommand } from './capture-command'

/** 详情操作、阅读页身份、改名与查询共用真实窗口；不触碰日常库。 */
export async function inspectorFlow(win: BrowserWindow, dir: string, { js, shot, chooseMenu }: {
  js(code: string): Promise<any>; shot(name: string): Promise<void>; chooseMenu(label: string): void
}) {
  const wait = (ms = 120) => new Promise(r => setTimeout(r, ms))
  const until = async (code: string) => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await wait() } throw Error('未就绪：' + code) }
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(libraryOf(win.webContents)!.core, method, ...args)
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait() }
  const input = async (value: string) => { await js(`(()=>{const e=document.querySelector('.inspector-title-editor input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await wait() }
  const saveName = async () => { await js(`document.querySelector('.inspector-title-editor input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`); await wait() }
  const pane = '[data-tab-content][data-tab-focused="true"]'
  const current = async () => { await wait(650); return js(`window.bridge.loadWorkspace(${JSON.stringify(libraryOf(win.webContents)!.id)})`) }
  const file = join(dir, '讲义.pdf')
  writeFileSync(file, imagePdf(await sharp({ create: { width: 400, height: 500, channels: 3, background: '#f4efe2' } }).jpeg().toBuffer(), 400, 500))
  const [id] = await call('ingest', [{ type: 'file', path: file }])
  await call('run', 'tags', 'update', { ids: [id], add: ['Math', 'Logic'] })
  await executeUiCommand(js, 'host.view.all')
  const select = async () => { await until(`!!document.querySelector('${pane} [data-entity-id="${id}"]')`); await js(`document.querySelector('${pane} [data-entity-id="${id}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait(250) }
  await select()
  await until(`document.querySelector('.inspector-title')?.textContent==='讲义.pdf'`)
  assert.equal(await js(`document.querySelectorAll('.inspector-actions button').length`), 5)
  assert.equal(await js(`document.querySelector('.inspector-primary').textContent`), '打开')
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-inspector-section="section:file"] dt')].map(e=>e.textContent).filter(t=>['文件名','格式','大小'].includes(t))`), [])
  await click('.inspector-section-actions [data-action-id="file.storage"]')
  await until(`document.querySelector('.export-dialog .export-title')?.textContent==='文件存储'`)
  await js(`document.querySelector('.export-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await wait()
  // More menu and card menu use the same source, including full-data takeout.
  chooseMenu('取回数据'); await click('.inspector-more')
  await until(`!!document.querySelector('.takeout-dialog')`)
  assert(await js(`document.querySelector('.takeout-dialog').textContent.includes('完整字段')`))
  await js(`document.querySelector('.takeout-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await wait()
  await click('[aria-label="重命名素材"]'); await input(''); await saveName()
  await until(`!!document.querySelector('.inspector-title-editor [role=alert]')`)
  await input('数学讲义'); await saveName()
  await until(`document.querySelector('.inspector-title')?.textContent==='数学讲义.pdf'`)
  assert.equal((await call('get',[id]))[0].blocks.file.data.name, '数学讲义.pdf')
  await call('undo'); await until(`document.querySelector('.inspector-title')?.textContent==='讲义.pdf'`)
  const collection = (await current()).active
  await click('.inspector-primary')
  await until(`document.querySelector('.inspector-primary')?.textContent==='正在查看'`)
  assert(await js(`document.querySelector('.inspector-primary').disabled`))
  await until(`document.querySelector('[data-container-type="context"]')?.textContent.includes('讲义.pdf')`)
  assert(await js(`document.querySelector('[data-container-type="context"]').textContent.includes('当前页面暂无适用工具')`))
  const reader = (await current()).active
  await shot('inspector-reader.png')
  await js(`document.querySelector('[data-tab="${collection}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait(); await select()
  await until(`document.querySelector('.inspector-primary')?.textContent==='定位到页面'`)
  await click('.inspector-primary'); assert.equal((await current()).active, reader)
  await js(`document.querySelector('[data-tab="${collection}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`); await wait()
  await until(`!!document.querySelector('.tag-nav-row .nav-item')`)
  await js(`[...document.querySelectorAll('.tag-nav-row .nav-item')].find(e=>e.textContent.includes('Math')).click()`)
  await until(`document.querySelector('${pane} .filter-bar')?.textContent.includes('标签： Math')`)
  assert(!await js(`document.querySelector('${pane} .filter-bar').textContent.includes('临时')`))
  await shot('inspector-collection.png')
  const size = win.getSize(); win.setSize(860, 690); await wait(400)
  assert(await js(`(()=>{const e=document.querySelector('.inspector-actions');return e.scrollWidth<=e.clientWidth+1})()`))
  await shot('inspector-narrow.png'); win.setSize(size[0],size[1]); await wait()
  // Multiple selection must not claim that the collection itself is a reader.
  const second = await call('create', { text: { content: '另一项' } })
  await executeUiCommand(js, 'host.view.all'); await click(pane + ' .filter-clear'); await select()
  await until(`!!document.querySelector('${pane} [data-entity-id="${second}"]')`)
  await js(`document.querySelector('${pane} [data-entity-id="${second}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,metaKey:true,ctrlKey:false}))`); await wait(250)
  assert(await js(`document.querySelector('.inspector-many-text')?.textContent.includes('2 项')`))
  assert.equal(await js(`document.querySelectorAll('.inspector-actions button').length`), 3)
  await shot('inspector-many.png')
  // 同一角标契约覆盖单页、未查看、第一页、中间页、末页与回翻；写入仍走原进度命令。
  assert.equal(await js(`document.querySelectorAll('${pane} [data-entity-id="${id}"] [data-pdf-reading]').length`), 0)
  const multi = join(dir, '多页讲义.pdf')
  writeFileSync(multi, imagePdf(await sharp({ create: { width: 400, height: 500, channels: 3, background: '#ece9e2' } }).jpeg().toBuffer(), 400, 500, 3))
  const [multiId] = await call('ingest', [{ type: 'file', path: multi }])
  await until(`!!document.querySelector('${pane} [data-entity-id="${multiId}"]')`)
  for (let i = 0; i < 100 && !(await call('get', [multiId]))[0].blocks.pdf; i++) await wait()
  const [multiView] = await call('get', [multiId])
  assert.equal(multiView.blocks.pdf.data.pages, 3)
  const badge = `${pane} [data-entity-id="${multiId}"] [data-pdf-reading]`
  assert.equal(await js(`document.querySelectorAll('${badge}').length`), 0)
  let stamp = Date.now()
  for (const page of [1, 2, 3, 2]) {
    await call('run', 'pdf', 'saveReading', { id: multiId, hash: String(multiView.blocks.file.data.hash), page, offset: 0, lastRead: ++stamp })
    await until(`document.querySelector('${badge}')?.dataset.pdfReading==='${page === 3 ? 'end' : 'reading'}'`)
    if (page === 3) {
      assert(await js(`document.querySelector('${badge}').title.includes('上次读到末页')`))
      await shot('pdf-reading-end.png')
    } else await until(`document.querySelector('${badge}')?.textContent==='${page} / 3 页'`)
  }
  const [singleView] = await call('get', [id])
  await call('run', 'pdf', 'saveReading', { id, hash: String(singleView.blocks.file.data.hash), page: 1, offset: 0, lastRead: ++stamp })
  await wait(300)
  assert.equal(await js(`document.querySelectorAll('${pane} [data-entity-id="${id}"] [data-pdf-reading]').length`), 0)
  await js(`document.querySelector('${pane} [data-entity-id="${multiId}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
  await until(`document.querySelector('.inspector-title')?.textContent==='多页讲义.pdf'`)
  const pdfSection = '[data-inspector-section="section:pdf"]'
  await until(`document.querySelector('${pdfSection} .pdf-props')?.textContent.includes('2 / 3 页')`)
  assert(await js(`document.querySelector('.inspector-meta-grid').textContent.includes('3 页')`))
  assert(!await js(`[...document.querySelectorAll('${pdfSection} dt')].some(e=>e.textContent==='页数')`))
  assert.equal(await js(`document.querySelectorAll('${pdfSection} .inspector-section-body button').length`), 0)
  assert.equal(await js(`document.querySelector('.inspector-primary').textContent`), '打开')
  win.setSize(860, 690); await wait(300)
  await js(`document.querySelector('${pdfSection}').scrollIntoView({block:'nearest'})`); await wait(150)
  assert(await js(`(()=>{const e=[...document.querySelectorAll('${pdfSection} dt')].find(e=>e.textContent==='阅读进度');const range=document.createRange();range.selectNodeContents(e);return range.getClientRects().length===1 && e.scrollWidth<=e.clientWidth+1})()`))
  await shot('pdf-details-narrow.png'); win.setSize(size[0],size[1]); await wait()
  await shot('pdf-reading-progress.png')
  // 顶部唯一的打开入口仍从保存页码续读。
  await click('.inspector-primary')
  await until(`document.querySelector('${pane} .pdf-page-jump')?.getAttribute('aria-label')?.includes('当前第 2 页')`)
  await until(`document.querySelector('.inspector-primary')?.textContent==='正在查看'`)
  await shot('pdf-details-resume.png')
  writeFileSync(join(dir, 'inspector-result.json'), JSON.stringify({ ok: true, id, reader, multiId }))
}
