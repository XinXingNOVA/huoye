import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { localRuntimes } from '../../src/main/runtime-settings'
import { callCore } from '../../src/main/core-client'
import { executable, inspectRuntime } from '../../src/platform/runtime-package'
import { libraryFileUrl } from '../../src/shared/file-location'

export async function mediaEditionsFlow(win: BrowserWindow, dir: string) {
  assert(process.env.RM_USER_DATA && process.env.LIBRARY_PATH, '请指定独立的 RM_USER_DATA 和测试仓库')
  const lib = libraryOf(win.webContents)!
  async function ready() {
    for (let n = 0; n < 200; n++) {
      if (!win.webContents.isLoadingMainFrame() && await win.webContents.executeJavaScript("!!document.querySelector('[aria-label=打开设置]')").catch(() => false)) return
      await new Promise(r => setTimeout(r, 100))
    }
    throw Error('工作台重载未完成')
  }
  async function reload() {
    await reloadLibrary(lib)
    await ready()
  }
  await ready()
  const store = localRuntimes()
  assert.equal(store.list().length, 0, '请使用全新的测试配置')
  const get = async (id: string) => (await callCore(lib.core, 'get', [id]))[0]
  async function idle() {
    for (let n = 0; n < 300; n++) {
      const s = await callCore(lib.core, 'processingSummary')
      if (!Object.values(s).some(Boolean)) return
      await new Promise(r => setTimeout(r, 100))
    }
    throw Error('媒体加工未结束')
  }
  const target = process.platform + '-' + process.arch
  const standard = join(dir, 'bundled'), offline = join(dir, 'bundled-offline')
  const make = (name: string, color: string) => {
    const output = join(dir, name + '.avi')
    execFileSync(join(standard, executable('ffmpeg', target)), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=128x96:d=2', '-c:v', 'mpeg4', output])
    return output
  }
  const files = [make('standard-video', 'blue'), make('lite-video', 'green'), make('quarantined', 'red')]
  const ingest = async (path: string) => (await callCore(lib.core, 'ingest', [{ type: 'file', path }]))[0]
  const demand = async (id: string) => {
    assert(await callCore(lib.core, 'demand', id, 'proxy'))
    await idle()
  }
  const kinds = ['video', 'still', 'frames', 'thumb', 'proxy']
  const produced = async (id: string) => {
    const item = await get(id)
    assert.deepEqual(item.failures, {})
    assert.equal(item.blocks.frames.data.count, 20)
    assert.equal(item.blocks.proxy.data.mode, 'transcode')
    return kinds.map(kind => {
      const block = item.blocks[kind]
      const path = block.data.path ? join(lib.root, String(block.data.path)) : undefined
      return { kind, seq: block.seq, mtime: path && statSync(path, { bigint: true }).mtimeNs.toString(),
        hash: path && createHash('sha256').update(readFileSync(path)).digest('hex') }
    })
  }
  const state = async (id: string, kind: string) => (await callCore(lib.core, 'processingStatus', { ids: [id], kinds: [kind] })).items[0].kinds[0]
  async function usable(id: string) {
    const { blocks } = await get(id)
    for (const kind of ['still', 'frames', 'proxy']) {
      const url = libraryFileUrl(lib.id, String(blocks[kind].data.path))
      const size = await win.webContents.executeJavaScript(kind === 'proxy'
        ? `new Promise((resolve, reject) => {
            const video = document.createElement('video')
            const timeout = setTimeout(() => reject(Error('video decode timeout')), 10000)
            video.muted = true
            video.preload = 'auto'
            video.onloadeddata = () => { clearTimeout(timeout); resolve(video.videoWidth) }
            video.onerror = () => { clearTimeout(timeout); reject(Error(video.error?.message)) }
            video.src = ${JSON.stringify(url)}
          })`
        : `(async () => { const image = new Image(); image.src = ${JSON.stringify(url)}; await image.decode(); return image.naturalWidth })()`)
      assert(size > 0)
    }
  }
  async function install(version: string) {
    const path = join(dir, 'packages', version + '.hyruntime')
    const { digest } = await inspectRuntime(path)
    await store.install(path, digest)
    store.setEnabled(digest, true)
    return digest
  }
  // Reopen the same library without an engine, then add a runtime and upgrade it.
  const original = await ingest(files[0])
  await idle()
  assert(!(await get(original)).blocks.proxy)
  await demand(original)
  const originalResult = await produced(original)
  renameSync(standard, offline)
  await reload()
  await idle()
  await usable(original)
  assert.deepEqual(await produced(original), originalResult)
  const pending = await ingest(files[1])
  await idle()
  assert.equal((await state(pending,'video')).state, 'blocked')
  assert(!(await get(pending)).blocks.still)
  assert.equal(await callCore(lib.core, 'demand', pending, 'proxy'), false)
  const first = await install('a')
  await reload()
  await idle()
  assert((await get(pending)).blocks.frames && !(await get(pending)).blocks.proxy)
  await demand(pending)
  await demand(original)
  assert.deepEqual(await produced(original), originalResult)
  const added = await produced(pending)
  const second = await install('b')
  assert.notEqual(first, second)
  await reload()
  await idle()
  for (const id of [original, pending]) await demand(id)
  assert.deepEqual(await produced(original), originalResult)
  assert.deepEqual(await produced(pending), added)

  // Quarantine only the selected executable. A working fallback is deliberately available.
  renameSync(offline, standard)
  const snapshot = store.snapshot()
  try {
    assert.equal(snapshot.programs.ffmpeg.digest, second)
    unlinkSync(snapshot.programs.ffmpeg.path)
  } finally { snapshot.release() }
  await reload()
  const broken = await ingest(files[2])
  await idle()
  assert.equal((await state(broken,'video')).state,'ready')
  const frames = await state(broken, 'frames')
  assert.equal(frames.state, 'blocked')
  assert.match(frames.reason!, /重新安装/)
  assert(!(await get(broken)).blocks.frames)
  assert.deepEqual((await get(broken)).failures, {})
  renameSync(standard, offline)
  store.setEnabled(second, false)
  await reload()
  await idle()
  assert.equal((await state(broken, 'frames')).state, 'blocked')
  await install('b')
  await reload()
  await idle()
  await demand(broken)
  await usable(broken)
  assert.deepEqual(await produced(original), originalResult)
  writeFileSync(join(dir,'media-editions.json'), JSON.stringify({ original, pending, broken, first, second, originalResult,
    cachedPlayback: true, blockedReason: frames.reason, repaired: !!(await produced(broken)) }, null, 2))
}
