import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { serveMediaSlots } from '../../src/main/media-slots'
import { callCore } from '../../src/main/core-client'
import { MediaSlots } from '../../src/shared/media-slots'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { findProgram, programDirectories } from '../../src/platform/programs'

const kind = 'media-test.result'
// 一个普通的开发插件。读轨道目录选择中文轨，写本插件自己的派生块。
const fixture = `
export const blocks = [{ id: 'media-test.result', title: '计算结果', plugin: 'media-test', version: 1, rebuildable: true,
  fields: { value: { type: 'json', title: '结果' }, source: { type: 'number', title: '原件序号' } } }]
const systems = ['audio', 'video'].map((kind, priority) => ({
  id: 'media-test.' + kind, priority, needs: [kind], has: ['file', kind], inputs: ['file.hash'],
  requires: { capabilities: ['media.inspect@1', kind === 'audio' ? 'audio.waveform@1' : 'media.subtitle@1'] },
  demand: true, outputs: ['media-test.result'],
  async run(ctx, id, b) {
    const source = { id, fileSeq: b.file.seq }
    const { tracks } = await ctx.capabilities.run('media.inspect@1', source)
    const value = kind === 'audio'
      ? await ctx.capabilities.run('audio.waveform@1', { ...source, track: tracks.find(t => t.type === 'audio').index, maxPeaks: 120 })
      : await ctx.capabilities.run('media.subtitle@1', { ...source, track: tracks.find(t => t.type === 'subtitle' && t.tags.language === 'zho').index })
    return { 'media-test.result': { value, source: source.fileSeq } }
  }
}))
export const plugin = { id: 'media-test', version: 1, blocks, systems }
`
async function until(check: () => Promise<unknown> | boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw Error(label)
}
async function shutdown(core: UtilityProcess) {
  const exit = once(core, 'exit', { signal: AbortSignal.timeout(5000) })
  core.postMessage({ type: 'shutdown' })
  try { await exit } catch (error) { core.kill(); throw error }
}

export async function mediaHeavyFlow(dir: string) {
  mkdirSync(dir, { recursive: true })
  const ffmpeg = findProgram('ffmpeg', programDirectories())
  assert(ffmpeg)
  const make = (args: string[]) => execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args])
  const wav = join(dir, 'reference.wav'), mkv = join(dir, 'bilingual.mkv'), quiet = join(dir, 'quiet.wav')
  make(['-f', 'lavfi', '-i', 'sine=duration=200', '-af', "volume=0:enable='lt(t,100)',pan=stereo|c0=c0|c1=-1*c0", wav])
  assert(statSync(wav).size > 32 * 1024 * 1024)
  make(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', quiet])
  const english = join(dir, 'en.srt'), chinese = join(dir, 'zh.srt')
  writeFileSync(english, '1\n00:00:00,250 --> 00:00:01,250\nEnglish track\n')
  writeFileSync(chinese, '1\n00:00:00,500 --> 00:00:01,500\n中文轨道\n')
  make(['-f', 'lavfi', '-i', 'color=blue:s=160x90:d=2', '-i', english, '-i', chinese, '-map', '0:v', '-map', '1:s', '-map', '2:s',
    '-c:v', 'libx264', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=zho', mkv])

  const directory = join(dir, 'consumer')
  mkdirSync(directory)
  writeFileSync(join(directory, 'core.mjs'), fixture)
  const pack = { development: true, directory, hash: createHash('sha256').update(fixture).digest('hex'),
    manifest: packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id: 'media-test', title: '验收', description: '', version: '1.0.0',
      author: 'test', requires: ['audio', 'video'], entries: { core: 'core.mjs' }, capabilities: { version: 1, consumes: ['media.inspect@1', 'audio.waveform@1', 'media.subtitle@1'] } }) }

  const cores = new Set<UtilityProcess>()
  const pool = new MediaSlots(1)
  // 留住一个名额，能确定地将两个真实仓库排在同一条队列，再放行。
  const reserve = () => pool.acquire(AbortSignal.timeout(10000))
  let resume = await reserve()
  const library = async (name: string) => {
    const core = utilityProcess.fork(join(__dirname, 'core.js'), [], { serviceName: 'Huoye media test ' + name })
    cores.add(core)
    core.once('exit', () => cores.delete(core))
    serveMediaSlots(core, pool)
    const events = { requested: 0, released: 0 }
    core.on('message', m => {
      if (m.type === 'media-slot-request') events.requested++
      if (m.type === 'media-slot-release') events.released++
    })
    const ready = once(core, 'message', { signal: AbortSignal.timeout(15000) })
    core.postMessage({ type: 'init', sharedMediaSlots: true, root: join(dir, name), packages: [pack] })
    assert.equal((await ready)[0].type, 'ready')
    assert((await callCore(core, 'info')).capabilities.some(c => c.id === 'audio.waveform@1' && c.state === 'ready'))
    return { core, events }
  }
  async function result(core: UtilityProcess, id: string, seq?: number) {
    const read = async () => (await callCore(core, 'get', [id]))[0]
    await until(async () => {
      const view = await read()
      assert.deepEqual(view.failures, {})
      const block = view.blocks[kind]
      return block && (!seq || block.data.source === seq)
    }, '加工未产生当前版本的结果')
    return (await read()).blocks[kind].data.value
  }
  try {
    const a = await library('music-library'), b = await library('movie-library')
    const [song] = await callCore(a.core, 'ingest', [{ type: 'file', path: wav }])
    const [film] = await callCore(b.core, 'ingest', [{ type: 'file', path: mkv }])
    assert(await callCore(a.core, 'demand', song, kind))
    await until(() => a.events.requested === 1, '音频未进入队列')
    assert(await callCore(b.core, 'demand', film, kind))
    await until(() => b.events.requested === 1, '字幕未进入队列')
    resume()
    const [wave, sub] = await Promise.all([result(a.core, song), result(b.core, film)]) as [{ peaks: number[] }, { text: string; track: number }]
    assert(wave.peaks.length <= 120 && wave.peaks.length > 60)
    assert.equal(wave.peaks[1], 0)
    assert(wave.peaks.at(-2)! > 0.11)
    assert.equal(sub.track, 2)
    assert.match(sub.text, /00:00:00,500 --> 00:00:01,500/)
    assert.match(sub.text, /中文轨道/)
    assert.doesNotMatch(sub.text, /English/)

    resume = await reserve()
    const redo = async (core: UtilityProcess, id: string) => {
      await callCore(core, 'regenerate', [id])
      assert(await callCore(core, 'demand', id, kind))
    }
    await redo(a.core, song)
    await until(() => a.events.requested === 2, '音频未排队重算')
    const preview = await callCore(a.core, 'prepareFileEdit', { id: song, destination: { mode: 'publish' },
      content: { type: 'file', path: quiet }, requestId: randomUUID() })
    const update = await callCore(a.core, 'commitFileEdit', { editId: preview.editId, previewToken: preview.previewToken, requestId: randomUUID() })
    assert.equal(update.library.state, 'accepted')
    await until(() => a.events.released === 2 && a.events.requested === 3, '换版没有撤销旧申请并重排新版')
    await redo(b.core, film)
    await until(() => b.events.requested === 2, '字幕未排队重算')
    await callCore(b.core, 'trash', [film])
    await until(() => b.events.released === 2, '回收没有取消排队')
    resume()
    const seq = (await callCore(a.core, 'get', [song]))[0].blocks.file.seq
    const replacement = await result(a.core, song, seq) as { peaks: number[] }
    assert(replacement.peaks.every(n => n === 0))
    resume = await reserve()
    await redo(a.core, song)
    await until(() => a.events.requested === 4, '关库前未排队')
    await shutdown(a.core)
    resume()
    const free = await reserve()
    free()
    writeFileSync(join(dir, 'media-heavy.json'), JSON.stringify({ audioBytes: statSync(wav).size, peaks: wave.peaks.length,
      peak: Math.max(...wave.peaks), subtitles: sub, replacementSeq: seq, replacementPeak: Math.max(...replacement.peaks),
      twoLibraries: true, cancelledOnTrash: true, closedWhileQueued: true }, null, 2))
  } finally {
    resume()
    await Promise.all([...cores].map(shutdown))
  }
}
