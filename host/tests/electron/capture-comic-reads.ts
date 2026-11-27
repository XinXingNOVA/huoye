import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary, imageDirectory } from '../../src/main/libraries'
import { workbenchContentWindow, workbenchSessionWindows } from '../../src/main/auxiliary-windows'
import { callCore } from '../../src/main/core-client'
import { script, until } from './theme-settings'
import type { PackagePreview } from '../../src/shared/external-plugins'

/** Optional end-to-end with the independent comic package and three distinct source encodings. */
export async function comicReadsFlow(win: BrowserWindow, dir: string) {
  const lib = libraryOf(win.webContents)!
  win.show()
  const ready = () => until(() => script(win, "!!document.querySelector('[aria-label=打开设置]')").catch(() => false), '工作台未就绪')
  const reload = async () => {
    await Promise.all([once(win.webContents, 'did-finish-load', { signal: AbortSignal.timeout(20000) }), reloadLibrary(lib)])
    await ready()
  }
  await ready()
  const pack = join(dir, 'comic.hyplugin')
  const preview: PackagePreview = await script(win, 'window.bridge.packages.previewFiles(' + JSON.stringify([pack]) + ')')
  await script(win, 'window.bridge.packages.install(' + JSON.stringify(preview.token) + ')')
  const disabled = (await callCore(lib.core, 'plugins')).filter(p => !p.external && p.chosen).map(p => p.id)
  await script(win, 'window.bridge.packages.apply(' + JSON.stringify({ disabled, changes: preview.items.map(i => ({ hash: i.hash, enabled: true })) }) + ')')
  await reload()
  const [id] = await callCore(lib.core, 'ingest', [{ type: 'file', path: join(dir, 'mixed.cbz') }])
  const entity = async (item: string) => (await callCore(lib.core, 'get', [item]))[0]
  await until(async () => {
    const book = await entity(id)
    assert.deepEqual(book.failures, {})
    return book.blocks.comic
  }, '新漫画未建立页索引')
  const index = (await entity(id)).blocks.comic.data
  assert.equal((index.assets as string[]).length, 1)
  assert.equal(index.pageCount, 3)
  async function open(item: string) {
    const card = `document.querySelector('[data-entity-id="${item}"][data-hy-part="resource-card"]')`
    await until(() => script(win, card + '?.checkVisibility()'), '素材卡不可见')
    await script(win, card + ".dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
  }
  const selector = '.cm-stage img[src*="_reads/"], .cm-canvas img[src*="_reads/"], .cm-reader img[src*="_reads/"]'
  const current = (w: BrowserWindow, page: number) => script(w, `[...document.querySelectorAll(${JSON.stringify(selector)})].find(i => i.alt === '第 ${page} 页' && i.complete && i.naturalWidth)?.src`)
  async function check(w: BrowserWindow, page: number, name: string, mime: string) {
    await until(() => current(w, page), '阅读器未显示第 ' + page + ' 页')
    const url = await current(w, page)
    const data = await script(w, `(async () => { const r=await fetch(${JSON.stringify(url)}); return {mime:r.headers.get('Content-Type'), digest:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await r.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('')} })()`)
    assert.equal(data.mime, mime)
    assert.equal(data.digest, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'))
    return url as string
  }
  const next = (w: BrowserWindow) => script(w, `document.querySelector('button[aria-label="下一页 →"]').click()`)
  await open(id)
  await check(win, 1, '01.png', 'image/png')
  await next(win)
  await check(win, 2, '02.jpg', 'image/jpeg')
  await script(win, `document.querySelector('button[title="收藏此页到素材库"]').click()`)
  const saved = async () => (await callCore(lib.core, 'query', { has: ['comicpage'] })).ids[0]
  await until(async () => { const sid = await saved(); return sid && (await entity(sid)).blocks.thumb }, '收藏页未生成缩略图')
  const sid = await saved()
  const favorite = (await entity(sid)).blocks
  assert.equal(favorite.comicpage.data.target, id)
  assert.equal(favorite.comicpage.data.name, '02.jpg')
  assert.equal(favorite.comicpage.data.sourceHash, index.sourceHash)
  const lease = randomUUID()
  const size = await callCore(lib.core, 'acquireImageRead', { lease, plugin: 'comic', capability: 'comic/archive.page@1',
    input: { id, fileSeq: (await entity(id)).blocks.file.seq, params: { entry: Number(favorite.comicpage.data.entry) } }, priority: 'display', maxEdge: 96 })
  // callCore 结束会关闭自己的 MessagePort，由宿主收回该连接上的租约。
  assert.deepEqual(size, { width: 74, height: 96, mime: 'image/webp' })
  const originalExport = preview.items.some(i => i.manifest?.coreFeatures?.includes('export-images-v1'))
  if (originalExport) {
    const exported = await callCore(lib.core, 'exportRun', { ids: [sid], titles: { [sid]: '收藏页' }, parent: dir, name: '原页导出' })
    assert.deepEqual(exported.failed, [])
    assert(readFileSync(join(exported.dir, '漫画收藏页', '收藏页.jpg')).equals(readFileSync(join(dir, '02.jpg'))))
  }
  const thumbPath = join(lib.root, String(favorite.thumb.data.path))
  const durable = readFileSync(thumbPath)
  await script(win, `document.querySelector('button[title="悬浮阅读"]').click()`)
  const child = () => {
    const window = workbenchSessionWindows(win).windows.find(w => w.id.startsWith('content:'))
    return window && workbenchContentWindow(win, window.id)
  }
  await until(child, '没有漫画浮窗')
  const floating = child()!
  await check(floating, 2, '02.jpg', 'image/jpeg')
  await next(floating)
  const old = await check(floating, 3, '03.webp', 'image/webp')
  await reload()
  assert.equal(await script(win, 'fetch(' + JSON.stringify(old) + ').then(r=>r.status)'), 404)
  assert(readFileSync(thumbPath).equals(durable))
  await open(sid)
  const windows = () => [win, ...workbenchSessionWindows(win).windows.flatMap(w => {
    const child = workbenchContentWindow(win, w.id)
    return child ? [child] : []
  })]
  let reader: BrowserWindow | undefined
  await until(async () => {
    for (const w of windows()) if (await current(w, 2)) { reader = w; return true }
    return false
  }, '收藏页未在主窗或原有小窗恢复')
  await check(reader!, 2, '02.jpg', 'image/jpeg')
  writeFileSync(join(dir, 'comic-reads.json'), JSON.stringify({ id, sid, encodings: ['png', 'jpeg', 'webp'], staleUrl: 404,
    size, originalExport, cachedPages: readdirSync(imageDirectory(lib.core)!).length, thumbnailBytes: durable.length }, null, 2))
}
