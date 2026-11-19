import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { audioCoverFixtures } from '../fixtures/audio-cover'
import { findProgram, programDirectories } from '../../src/platform/programs'
import type { CoreApi } from '../../src/shared/rpc'
import type { PackagePreview } from '../../src/shared/external-plugins'
import { callCore } from '../../src/main/core-client'
import { libraryOf, reloadLibrary } from '../../src/main/libraries'
import { selectCapturePackage } from '../../src/main/plugin-packages'

interface Tools { js(code: string): Promise<any>; log(label: string, value: unknown): void; shot(name: string): Promise<void> }
export async function audioCoverFlow(win: BrowserWindow, dir: string, { js, log, shot }: Tools) {
  win.webContents.setAudioMuted(true)
  const lib = () => libraryOf(win.webContents)!
  const call = <K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>) => callCore(lib().core, method, ...args)
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const until = async (fn: () => Promise<unknown>, message: string) => {
    for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)) }
    throw new Error(message)
  }
  const pane = `document.querySelector('.tab-pane:not(.hidden)')`
  const loaded = (selector: string) => js(`(() => {const img=document.querySelector(${JSON.stringify(selector)});return !!img && img.complete && img.naturalWidth>0})()`)
  const click = async (selector: string, text?: string) => {
    check(await js(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length && ${text ? `e.textContent.trim()===${JSON.stringify(text)}` : 'true'});e?.click();return !!e})()`), `找不到 ${text ?? selector}`)
    await new Promise(r => setTimeout(r, 180))
  }
  if (process.env.CAPTURE_FLOW === 'audiocoverresume') {
    const saved = JSON.parse(readFileSync(join(dir, 'audio-cover-state.json'), 'utf8'))
    await until(() => loaded(`.music-song[data-track-id="${saved.id}"] img`), '重启后歌曲封面没有恢复')
    const view = (await call('get', [saved.id]))[0]
    check(view.blocks.still.seq === saved.stillSeq && view.blocks.thumb.seq === saved.thumbSeq, '重启重复加工封面')
    await shot('audio-cover-4-resume.png')
    writeFileSync(join(dir, 'audio-cover-resume.json'), JSON.stringify({ ok: true, checks: ['封面恢复', '未重复加工'] }))
    log('音频封面重启通过', saved.id); return
  }
  const input = join(dir, '新音频'); mkdirSync(input)
  const ffmpeg = findProgram('ffmpeg', programDirectories([resolve(`resources/media/${process.platform}-${process.arch}/bin`)]))
  check(ffmpeg, '缺少 ffmpeg')
  const fixtures = await audioCoverFixtures(input, ffmpeg!)
  const paths = [...fixtures.covered, fixtures.multi, fixtures.plain, fixtures.broken]
  // 第一首真实经过拖入入口，其余同批调用核心；全部文件都是本次刚生成的。
  const point = await js(`(() => {const r=${pane}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+120)}})()`)
  win.webContents.debugger.attach('1.3')
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: [paths[0]], dragOperationsMask: 1 } })
  } finally { win.webContents.debugger.detach() }
  await until(async () => (await call('query', { has: ['audio'] })).ids.length === 1, '带封面音频未收录')
  const first = (await call('query', { has: ['audio'] })).ids[0]
  const ids = [first, ...await call('ingest', paths.slice(1).map(path => ({ type: 'file' as const, path })))]
  await until(async () => {
    const views = await call('get', ids)
    return views.slice(0, 4).every(v => v.blocks.thumb) && views[4].blocks.audio && views[5].failures['audio.still']
  }, '封面加工未完成')
  const views = await call('get', ids), before = views[0].blocks
  for (const [i, v] of views.entries()) {
    check(!v.blocks.video && !v.blocks.audioProxy, '封面导致音频被当成视频或提前转码')
    check(readFileSync(join(lib().root, String(v.blocks.file.data.path))).equals(readFileSync(paths[i])), '原文件变化')
  }
  check(!views[4].blocks.thumb && !views[5].blocks.thumb, '无封面或损坏封面不应伪造缩略图')
  await click('.sidebar .nav-item', '音频')
  for (const id of ids.slice(0, 4)) await until(() => loaded(`.tab-pane:not(.hidden) [data-entity-id="${id}"] img.cover-img`), '素材列表没有显示封面')
  check(await js(`!!${pane}.querySelector('[data-entity-id="${ids[4]}"] .audio-cover')`), '没有保留无封面占位')
  await shot('audio-cover-1-grid.png')
  await js(`${pane}.querySelector('[data-entity-id="${first}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await until(() => loaded('.tab-pane:not(.hidden) .audio-art img'), '音频播放器未显示封面')
  await until(() => js(`document.querySelector('.audio-player audio')?.readyState>=2`), '音频无法解码')
  await shot('audio-cover-2-player.png')
  await call('run', 'file', 'rename', { names: { [first]: '封面测试改名' } }); await call('undo')
  check((await call('get', [first]))[0].blocks.still.seq === before.still.seq, '改名重复加工封面')

  selectCapturePackage(resolve(process.env.PLUGIN_PACKAGE ?? 'artifacts/plugins/music.rmplugin'))
  const preview = await js('window.bridge.packages.pick()') as PackagePreview
  check(preview.items[0].manifest?.id === 'music', '不是音乐包')
  await js(`window.bridge.packages.install(${JSON.stringify(preview.token)})`)
  await js(`window.bridge.packages.apply(${JSON.stringify({ disabled: [], changes: [{ hash: preview.items[0].hash, enabled: true }] })})`)
  await reloadLibrary(lib())
  await until(() => js(`!!document.querySelector('.activity-entry[data-panel-id="music.library"]')`), '音乐包未加载')
  await click('.activity-entry[data-panel-id="music.library"]')
  await click('.music-navigation .music-nav-link', '全部歌曲')
  await until(() => loaded(`.music-song[data-track-id="${first}"] img`), '外部音乐界面没有使用公共封面')
  await click(`.music-song[data-track-id="${first}"] .music-row-play`)
  await until(() => js(`document.querySelector('audio.music-audio')?.readyState>=2`), '外部音乐界面无法播放')
  await shot('audio-cover-3-music.png')
  const final = (await call('get', [first]))[0].blocks
  writeFileSync(join(dir, 'audio-cover-state.json'), JSON.stringify({ id: first, stillSeq: final.still.seq, thumbSeq: final.thumb.seq }))
  await new Promise(r => setTimeout(r, 800))
  const checks = ['新 MP3／FLAC／M4A 封面', '多图优先正面', '无封面／坏图占位', '原文件字节', '列表与播放器图像解码', '外部音乐包封面与播放', '改名不重做']
  writeFileSync(join(dir, 'audio-cover-result.json'), JSON.stringify({ ok: true, ids, checks }, null, 2)); log('音频封面通过', checks)
}
