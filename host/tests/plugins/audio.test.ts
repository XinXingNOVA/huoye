import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseMediaInspection } from '../../src/core/media-inspect'
import { parseProbe } from '../../src/plugins/audio/probe'
import { openHost, tempDir } from '../helpers/helpers'

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)
const dir = tempDir('rm-audio-source-')
const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0)) clean() })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function setup(root?: string) {
  const h = openHost(undefined, { concurrency: 4 }, root)
  cleanups.push(h.cleanup)
  return h
}
const formats = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aiff']
beforeAll(() => {
  if (!ffmpeg) return
  for (const ext of formats) execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    ...(ext === 'ogg' ? ['-c:a', 'vorbis', '-strict', 'experimental', '-ac', '2'] : []),
    '-metadata', 'title=测试曲目', '-metadata', 'artist=音频测试作者', '-metadata', 'album=素材专辑', join(dir, `sample.${ext}`)
  ])
}, 30_000)

it('音轨探测容忍缺失数值和大小写标签，拒绝没有音轨的文件', () => {
  expect(parseProbe(parseMediaInspection({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', duration: '2.5', sample_rate: 'N/A', tags: { TITLE: '曲目' } }], format: { duration: 'N/A' } }), 'mp3'))
    .toMatchObject({ duration: 2.5, title: '曲目', sampleRate: undefined, playable: true })
  expect(() => parseProbe(parseMediaInspection({ streams: [{ index: 0, codec_type: 'video' }], format: {} }), 'mp3')).toThrow('没有音轨')
})

describe.skipIf(!ffmpeg)('音频插件实际加工', () => {
  it.each(formats)('%s：导入原文件、生成信息、不提前转码，复用既有检索与读取', async ext => {
    const { host } = setup()
    const src = join(dir, `sample.${ext}`)
    const [id] = await host.api.ingest([{ type: 'file', path: src }])
    await host.scheduler.idle()
    const b = host.store.blocksOf(id)
    expect(Number(b.audio.data.duration)).toBeCloseTo(3, 0)
    expect(b.audio.data.channels).toBe(ext === 'ogg' ? 2 : 1)
    expect(b.audio.data.sampleRate).toBe(44100)
    expect(b.audio.data.playable).toBe(ext !== 'aiff')
    expect(b.audioProxy).toBeUndefined()
    expect(b.video).toBeUndefined()
    expect(readFileSync(host.lib.files.readable(String(b.file.data.path)))).toEqual(readFileSync(src))
    expect(await host.api.ingest([{ type: 'file', path: src }])).toEqual([id])
    expect((await host.api.describeLibrary()).kinds.find(k => k.id === 'audio')?.fields.artist.search).toBe(true)
    if (ext !== 'aiff') {
      expect((await host.api.searchPage({ query: { has: ['audio'], search: [{ kind: 'audio', field: 'artist', text: '测试作者' }] } })).items.map(i => i.id)).toEqual([id])
      expect((await host.api.readContent({ id, kind: 'audio', field: 'title' })).text).toBe('测试曲目')
    }
  })

  it('AIFF 按需转换，改名不重复加工；停用音频后原文件、进度、检索与取回继续可用', async () => {
    const a = setup()
    const { host, root } = a
    const src = join(dir, 'sample.aiff')
    const [id] = await host.api.ingest([{ type: 'file', path: src }])
    await host.scheduler.idle()
    expect(host.api.demand(id, 'audioProxy')).toBe(true)
    await host.scheduler.idle()
    const before = host.store.blocksOf(id)
    const proxy = before.audioProxy.data
    expect(existsSync(join(root, String(proxy.path)))).toBe(true)
    expect(proxy.source).toBe(before.file.data.hash)
    const probe = JSON.parse(execFileSync(ffmpeg!.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', join(root, String(proxy.path))]).toString())
    expect(probe.streams[0]).toMatchObject({ codec_name: 'aac', channels: 2, sample_rate: '48000' })
    host.api.run('file', 'rename', { names: { [id]: '重新命名' } })
    await host.scheduler.idle()
    expect(host.store.blocksOf(id).audio.seq).toBe(before.audio.seq)
    expect(host.store.blocksOf(id).audioProxy.seq).toBe(before.audioProxy.seq)
    await host.api.put(id, 'audioPlayback', { position: 1, plays: 1, finished: false, lastPlayed: Date.now() })
    await host.api.setPlugins(['audio', 'video'])
    host.close()
    const b = setup(root)
    const retained = b.host.store.blocksOf(id)
    expect(retained.audioPlayback.data.position).toBe(1)
    expect(retained.audioProxy).toEqual(before.audioProxy)
    expect(b.host.reg.kind('audio')?.dormant).toBe(true)
    expect((await b.host.api.query({ has: ['audio'] })).ids).toEqual([id])
    const takeout = await b.host.api.takeoutRun({ ids: [id], parent: dir, name: '取回音频' })
    expect(takeout.problems).toEqual([])
    expect(takeout.files).toBe(1)
    expect(readFileSync(b.host.lib.files.readable(String(retained.file.data.path)))).toEqual(readFileSync(src))
    await b.host.api.setPlugins(['video'])
    b.host.close()
    const c = setup(root)
    await c.host.scheduler.idle()
    expect(c.host.reg.systems.some(s => s.id === 'audio.probe')).toBe(true)
    expect(c.host.reg.systems.some(s => s.id.startsWith('video.'))).toBe(false)
    expect(c.host.store.blocksOf(id).audioPlayback.data.position).toBe(1)
  })

  it('损坏音频不影响原文件收录和同批正常文件的加工', async () => {
    const { host } = setup()
    const broken = join(dir, 'broken.mp3')
    writeFileSync(broken, 'this is not audio')
    const ids = await host.api.ingest([{ type: 'file', path: broken }, { type: 'file', path: join(dir, 'sample.wav') }])
    await host.scheduler.idle()
    const [bad, good] = host.store.get(ids)
    expect(bad.blocks.file).toBeTruthy()
    expect(bad.blocks.audio).toBeUndefined()
    expect(bad.failures['audio.probe']).toBeTruthy()
    expect(good.blocks.audio).toBeTruthy()
  })
})
