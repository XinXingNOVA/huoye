import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { utilityProcess, type BrowserWindow } from 'electron'
import { libraryOf } from '../../src/main/libraries'
import { callCore } from '../../src/main/core-client'
import { findProgram, programDirectories } from '../../src/platform/programs'

/** 主窗口使用正常程序发现。另开隔离的核心会话，以空搜索目录验证缺少程序时的真实导入。 */
export async function mediaCapabilitiesFlow(win: BrowserWindow, dir: string) {
  const core = libraryOf(win.webContents)!.core
  const ffmpeg = findProgram('ffmpeg', programDirectories())
  assert(ffmpeg, '生成验收样本需要 ffmpeg')
  const audio = join(dir, 'probe.wav'), movie = join(dir, 'tracks.mkv')
  const make = (args: string[]) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args])
  make(['-f', 'lavfi', '-i', 'sine=duration=2', '-metadata', 'title=能力探测', audio])
  make(['-f', 'lavfi', '-i', 'color=blue:s=160x90:d=2', '-i', audio, '-map', '0:v', '-map', '1:a', '-map', '1:a',
    '-c:v', 'libx264', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=zho', movie])

  const info = await callCore(core, 'info')
  assert(info.capabilities.some(c => c.id === 'media.inspect@1' && c.state === 'ready'))
  const ids = await callCore(core, 'ingest', [audio, movie].map(path => ({ type: 'file', path })))
  for (let attempt = 0; attempt < 100; attempt++) {
    const [audioItem, videoItem] = await callCore(core, 'get', ids)
    if (audioItem.blocks.audio && videoItem.blocks.still) break
    assert.deepEqual(audioItem.failures, {})
    assert.deepEqual(videoItem.failures, {})
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const [song, film] = await callCore(core, 'get', ids)
  assert.equal(song.blocks.audio.data.sampleRate, 44100)
  assert.equal(song.blocks.audio.data.title, '能力探测')
  assert.equal(film.blocks.video.data.width, 160)
  assert.equal(film.blocks.video.data.audio, 'aac')
  assert(film.blocks.still.data.path)

  const missing = utilityProcess.fork(join(__dirname, 'core.js'), [], { serviceName: 'Huoye capability acceptance' })
  try {
    const ready = once(missing, 'message', { signal: AbortSignal.timeout(15000) })
    missing.postMessage({ type: 'init', root: join(dir, 'no-engine'), programDirs: [] })
    assert.equal((await ready)[0].type, 'ready')
    const state = await callCore(missing, 'info')
    assert(state.capabilities.some(c => c.id === 'media.inspect@1' && c.state === 'unavailable' && c.reason.includes('ffprobe')))
    const items = await callCore(missing, 'ingest', [{ type: 'file', path: movie }])
    const [view] = await callCore(missing, 'get', items)
    assert(view.blocks.file && !view.blocks.video)
    const status = await callCore(missing, 'processingStatus', { ids: items, kinds: ['video'] })
    assert.equal(status.items[0].kinds[0].state, 'blocked')
    assert.match(status.items[0].kinds[0].reason!, /ffprobe/)
    writeFileSync(join(dir, 'media-capabilities.json'), JSON.stringify({
      available: info.capabilities, audio: song.blocks.audio.data, video: film.blocks.video.data,
      hasCover: !!film.blocks.still, missing: status.items[0].kinds
    }, null, 2))
  } finally {
    const exit = once(missing, 'exit', { signal: AbortSignal.timeout(5000) })
    missing.postMessage({ type: 'shutdown' })
    try { await exit } catch (error) { missing.kill(); throw error }
  }
}
