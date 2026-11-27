import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { callCore } from '../../src/main/core-client'
import { libraryOf, openLibrary, reloadLibrary, type OpenLibrary } from '../../src/main/libraries'
import type { RuntimeInfo } from '../../src/shared/shared-runtimes'
import { findProgram, programDirectories } from '../../src/platform/programs'
import { libraryFileUrl } from '../../src/shared/file-location'
import { findSettingsSurface } from './settings-surface'

async function until<T>(label: string, read: () => Promise<T>) {
  for (let i = 0; i < 300; i++) {
    const value = await read()
    if (value) return value
    await new Promise(r => setTimeout(r, 100))
  }
  throw Error(label)
}
export async function sharedRuntimesFlow(win: BrowserWindow, dir: string) {
  const a = libraryOf(win.webContents)!
  const b = await openLibrary(join(dir, 'library-b'), { show: false })
  const js = (s: string) => win.webContents.executeJavaScript(s)
  const inventory = (): Promise<RuntimeInfo[]> => js('window.bridge.providers.runtimes()')
  const state = async (lib: OpenLibrary) => (await callCore(lib.core, 'info')).capabilities.find(c => c.id === 'media.inspect@1')!.state
  const ffmpeg = findProgram('ffmpeg', programDirectories())!
  for (const lib of [a, b]) assert.equal(await state(lib), 'unavailable')
  const cover = join(dir, 'cover.jpg')
  execFileSync(ffmpeg, ['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x90','-frames:v','1', cover])
  const song = join(dir, 'new-song.mp3')
  execFileSync(ffmpeg, ['-v','error','-y','-f','lavfi','-i','sine=duration=1','-i',cover,'-map','0:a','-map','1:v','-c:v','copy','-disposition:v','attached_pic',song])
  const items = await Promise.all([a,b].map(async lib => {
    const [id] = await callCore(lib.core, 'ingest', [{ type: 'file', path: song }])
    const [view] = await callCore(lib.core, 'get', [id])
    assert(view.blocks.file && !view.blocks.still)
    return { lib, id, hash: view.blocks.file.data.hash }
  }))
  const settingsPage = async () => {
    await until('工作台尚未就绪', () => js("!!document.querySelector('[aria-label=打开设置]')").catch(() => false))
    await js("document.querySelector('[aria-label=打开设置]').click()")
    return until('找不到计算引擎设置', async () => {
      const surface = findSettingsSurface(win)
      if (!surface) return
      const ready = await surface.webContents.executeJavaScript(`(() => {
        if ([...document.querySelectorAll('button')].some(b=>b.textContent==='安装共享运行包')) return true;
        [...document.querySelectorAll('.application-settings-nav button')].find(b=>b.textContent.trim()==='计算引擎')?.click()
      })()`)
      if (ready) return surface
    })
  }
  const press = (surface: BrowserWindow, label: string) => until(label, () => surface.webContents.executeJavaScript(
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.disabled); b?.click(); return !!b })()`))
  const surface = await settingsPage()
  const pick = dialog.showOpenDialog, prompt = dialog.showMessageBox
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(dir, 'ffmpeg.hyruntime')] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    await press(surface, '安装共享运行包')
    await until('运行包未安装', async () => (await inventory()).length === 1)
  } finally { dialog.showOpenDialog = pick; dialog.showMessageBox = prompt }
  const [installed] = await inventory()
  assert(!installed.enabled)
  await press(surface, '启用')
  await until('运行包未启用', async () => (await inventory())[0].enabled)
  assert.equal(await state(a), 'unavailable')
  await Promise.all([reloadLibrary(a), reloadLibrary(b)])
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const covers = await Promise.all(items.map(async ({ lib, id }) => {
    assert.equal(await state(lib), 'ready')
    return until('旧素材没有补出封面与缩略图', async () => {
      const [v] = await callCore(lib.core, 'get', [id])
      assert.deepEqual(v.failures, {})
      if (v.blocks.still?.data.path && v.blocks.thumb?.data.path) return [v.blocks.still, v.blocks.thumb].map(block => hash(join(lib.root, String(block.data.path))))
    })
  }))
  assert.deepEqual(covers[0], covers[1])
  await press(await settingsPage(), '停用')
  await until('运行包未停用', async () => !(await inventory())[0].enabled)
  const remove = () => js('window.bridge.providers.removeRuntime(' + JSON.stringify(installed.digest) + ')')
  await assert.rejects(remove(), /仓库/)
  await reloadLibrary(a)
  assert.equal(await state(b), 'ready')
  await assert.rejects(remove(), /仓库/)
  await reloadLibrary(b)
  await until('运行包仍被占用', async () => !(await inventory())[0].inUse)
  await press(await settingsPage(), '移除')
  await until('运行包未移除', async () => !(await inventory()).length)
  for (const [i, {lib, id, hash: source}] of items.entries()) {
    assert.equal(await state(lib), 'unavailable')
    const [v] = await callCore(lib.core, 'get', [id])
    assert.equal(v.blocks.file.data.hash, source)
    const images = [v.blocks.still, v.blocks.thumb].map(block => String(block.data.path))
    assert.deepEqual(images.map(path => hash(join(lib.root, path))), covers[i])
    for (const path of images) {
      const url = libraryFileUrl(lib.id, path)
      assert(await lib.win.webContents.executeJavaScript(`(async () => {
        const img = new Image(); img.src = ${JSON.stringify(url)}; await img.decode(); return img.naturalWidth > 0
      })()`))
    }
  }
  writeFileSync(join(dir, 'shared-runtimes.json'), JSON.stringify({ installed, libraries: items.map(e=>e.lib.id), covers, removed: true }, null, 2))
}
