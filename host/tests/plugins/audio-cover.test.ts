import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { audioCoverFixtures } from '../fixtures/audio-cover'
import { coverStreams } from '../../src/plugins/audio/probe'
import { findProgram, programDirectories } from '../../src/platform/programs'
import { legacyCorePlugins } from '../helpers/legacy-plugins'
import { openHost, tempDir } from '../helpers/helpers'

const media = resolve(`resources/media/${process.platform}-${process.arch}/bin`)
const ffmpeg = findProgram('ffmpeg', programDirectories([media]))
const dir = tempDir('rm-cover-fixtures-'), roots = new Set<string>(), hosts: ReturnType<typeof openHost>['host'][] = []
let files: Awaited<ReturnType<typeof audioCoverFixtures>>
beforeAll(async () => { if (ffmpeg) files = await audioCoverFixtures(dir, ffmpeg) }, 30000)
afterEach(() => { hosts.splice(0).forEach(h => h.close()); for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear() })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function setup(old = false, root?: string) {
  const plugins = old ? legacyCorePlugins.map(p => p.id === 'audio' ? { ...p, systems: p.systems?.filter(s => s.id !== 'audio.still') } : p) : legacyCorePlugins
  const h = openHost(plugins, { programDirs: programDirectories([media]) }, root)
  hosts.push(h.host); roots.add(h.root); return h
}

it('只选明确的内嵌图片，正面优先、顺序稳定，排除普通视频和无效索引', () => {
  expect(coverStreams({ tags: {}, tracks: [
    { index: 0, type: 'video', attachedPicture: false, tags: {} },
    { index: 1, type: 'video', attachedPicture: true, tags: { comment: 'Cover (back)' } },
    { index: 2, type: 'video', attachedPicture: true, tags: {} },
    { index: 3, type: 'video', attachedPicture: true, tags: { COMMENT: 'Cover (front)' } },
    { index: -1, type: 'video', attachedPicture: true, tags: {} }
  ] })).toEqual([3, 2, 1])
})

describe.skipIf(!ffmpeg)('真实内嵌封面', () => {
  it.each([0, 1, 2])('MP3／FLAC／M4A #%i 接入公共代表图、缩略图和色板，原文件不变', async i => {
    const { host } = setup(), source = files.covered[i], original = readFileSync(source)
    const [id] = await host.api.ingest([{ type: 'file', path: source }]); await host.scheduler.idle()
    const view = host.store.get([id])[0], b = view.blocks
    expect(view.failures).toEqual({})
    expect(b.audio).toBeTruthy(); expect(b.video).toBeUndefined(); expect(b.audioProxy).toBeUndefined()
    expect(b.still.data.path).toBe(`cache/audio-covers/${id}.jpg`)
    expect(b.thumb.data).toMatchObject({ width: 640, height: 640 })
    expect(host.reg.aspectOf(b)).toBe(1)
    expect(readFileSync(host.lib.files.readable(String(b.file.data.path)))).toEqual(original)
    expect(readFileSync(source)).toEqual(original)
    host.api.run('file', 'rename', { names: { [id]: '新名称' } }); await host.scheduler.idle()
    expect(host.store.blocksOf(id).still.seq).toBe(b.still.seq)
    expect(host.store.blocksOf(id).thumb.seq).toBe(b.thumb.seq)
  })

  it('有多张图时取正面；没有图与坏图仍保留可播放音轨，失败不阻塞其他素材', async () => {
    const { host, root } = setup()
    const ids = await host.api.ingest([files.multi, files.plain, files.broken].map(path => ({ type: 'file', path })))
    await host.scheduler.idle()
    const [multi, plain, bad] = host.store.get(ids)
    const stats = await sharp(join(root, String(multi.blocks.thumb.data.path))).stats()
    expect(stats.channels[0].mean).toBeGreaterThan(stats.channels[2].mean * 2)
    expect(plain.blocks.audio).toBeTruthy(); expect(plain.blocks.still).toBeUndefined(); expect(plain.blocks.thumb).toBeUndefined()
    expect(plain.failures).toEqual({})
    expect(bad.blocks.audio.data.playable).toBe(true)
    expect(bad.blocks.still).toBeUndefined()
    expect(bad.failures['audio.still']).toContain('无法读取内嵌封面')
    expect(existsSync(join(root, `cache/audio-covers/${bad.id}.jpg.part`))).toBe(false)
  })

  it('已有歌曲开库自动补齐；重开不重复加工，停用预览不会连带停用音频', async () => {
    const a = setup(true), [id] = await a.host.api.ingest([{ type: 'file', path: files.covered[0] }]); await a.host.scheduler.idle()
    expect(a.host.store.blocksOf(id).thumb).toBeUndefined()
    const audioSeq = a.host.store.blocksOf(id).audio.seq
    a.host.close()
    const b = setup(false, a.root); await b.host.scheduler.idle()
    const covered = b.host.store.blocksOf(id)
    expect(covered.thumb).toBeTruthy(); expect(covered.audio.seq).toBe(audioSeq)
    b.host.close()
    const c = setup(false, a.root); await c.host.scheduler.idle()
    expect(c.host.store.blocksOf(id).still.seq).toBe(covered.still.seq)
    await c.host.api.setPlugins(['preview']); c.host.close()
    const d = setup(false, a.root); await d.host.scheduler.idle()
    expect(d.host.plan.off.has('audio')).toBe(false)
    expect(d.host.reg.systems.some(s => s.id === 'audio.still')).toBe(false)
    expect(d.host.store.blocksOf(id).thumb).toEqual(covered.thumb)
  })
})
