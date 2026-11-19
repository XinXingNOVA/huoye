// 视频插件：用本机 ffmpeg 生成测试视频，走一遍真实的加工链。没有 ffmpeg 时跳过。

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openHost, tempDir } from '../helpers/helpers'

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync)
const dir = tempDir('rm-video-')

function make(name: string, args: string[]): string {
  const out = join(dir, name)
  execFileSync(ffmpeg!, ['-v', 'error', '-y', ...args, out])
  return out
}

let mp4: string, avi: string, rotated: string, long: string

beforeAll(() => {
  if (!ffmpeg) return
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine']
  mp4 = make('clip.mp4', [...src, '-t', '6', '-c:v', 'libx264', '-c:a', 'aac'])
  avi = make('old.avi', [...src, '-t', '3', '-c:v', 'mpeg4', '-c:a', 'libmp3lame'])
  rotated = make('phone.mp4', ['-display_rotation', '90', '-i', mp4, '-c', 'copy'])
  long = make('long.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '100', '-c:v', 'libx264', '-g', '50'])
}, 60_000)

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup() {
  const h = openHost(undefined, { concurrency: 4 })
  cleanups.push(h.cleanup)
  return h
}

describe.skipIf(!ffmpeg)('视频插件', () => {
  it('MP4：视频块 → 代表图 → 缩略图 → 色板；预览帧；不生成代理', async () => {
    const { host, root } = setup()
    const [id] = await host.api.ingest([{ type: 'file', path: mp4 }])
    await host.scheduler.idle()
    const b = host.store.blocksOf(id)

    expect(b.video.data).toMatchObject({ width: 640, height: 360, codec: 'h264', audio: 'aac', rotation: 0, playable: true })
    expect(Number(b.video.data.duration)).toBeCloseTo(6, 0)
    expect(String(b.still.data.path)).toMatch(/^cache\/stills\//)
    expect(b.still.data.at).toBeCloseTo(0.6, 1)
    expect(b.thumb).toBeTruthy()

    const frames = await sharp(join(root, String(b.frames.data.path))).metadata()
    expect(frames.width).toBe(240 * 20)
    expect(b.frames.data.tileHeight).toBe(frames.height)
    expect(b.proxy).toBeUndefined()

    const res = host.api.query({}) as { aspects: number[] }
    expect(res.aspects[0]).toBeCloseTo(16 / 9, 2)
  })

  it('竖拍视频：宽高按旋转换算', async () => {
    const { host } = setup()
    const [id] = await host.api.ingest([{ type: 'file', path: rotated }])
    await host.scheduler.idle()
    const v = host.store.blocksOf(id).video.data
    expect([v.width, v.height]).toEqual([360, 640])
    expect([90, 270]).toContain(v.rotation)
  })

  it('长视频逐帧跳转取预览帧', async () => {
    const { host, root } = setup()
    const [id] = await host.api.ingest([{ type: 'file', path: long }])
    await host.scheduler.idle()
    const b = host.store.blocksOf(id)
    expect(b.video.data.audio).toBeUndefined()
    const frames = await sharp(join(root, String(b.frames.data.path))).metadata()
    expect(frames.width).toBe(240 * 20)
  })

  it('AVI：不能直接播放；请求后才转码出代理，报告进度', async () => {
    const { host, root, events } = setup()
    const [id] = await host.api.ingest([{ type: 'file', path: avi }])
    await host.scheduler.idle()
    let b = host.store.blocksOf(id)
    expect(b.video.data).toMatchObject({ codec: 'mpeg4', playable: false })
    expect(b.still).toBeTruthy()
    expect(b.proxy).toBeUndefined()

    expect(host.api.demand(id, 'proxy')).toBe(true)
    await host.scheduler.idle()
    b = host.store.blocksOf(id)
    expect(b.proxy.data.mode).toBe('transcode')
    const probe = JSON.parse(
      execFileSync(ffmpeg!.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', join(root, String(b.proxy.data.path))]).toString()
    ) as { streams: { codec_name: string }[] }
    expect(probe.streams.map((s) => s.codec_name)).toEqual(expect.arrayContaining(['h264', 'aac']))
    expect(events.some((e) => e.event === 'job' && (e.payload as { system: string }).system === 'video.proxy')).toBe(true)
  })
})

// 视频的时间段批注（设计文档 11.2）：片段是一个身份，锚点块依附引用原视频；
// 视频插件为这种锚点截起点那一帧作代表图，批注插件没有启用时这个加工不装配。
describe.skipIf(!ffmpeg)('视频片段', () => {
  const segment = (target: string) => ({
    anchor: { target, type: '时间段', start: 3, end: 4.5, aspect: 16 / 9 },
    note: { text: '运镜很稳' },
    tags: { values: ['镜头'] }
  })

  it('截起点那一帧作代表图，预览插件接上缩略图；按原视频查出它；原视频进回收站，片段跟着', async () => {
    const { host, root } = setup()
    const [video] = await host.api.ingest([{ type: 'file', path: mp4 }])
    await host.scheduler.idle()
    const seg = host.api.create(segment(video)) as string
    await host.scheduler.idle()

    const b = host.store.blocksOf(seg)
    expect(String(b.still.data.path)).toBe(join('cache', 'locals', `${seg}.jpg`))
    expect(b.still.data.at).toBe(3)
    const meta = await sharp(join(root, String(b.still.data.path))).metadata()
    expect([meta.width, meta.height]).toEqual([640, 360])
    expect(b.thumb).toBeTruthy()
    expect(host.api.query({ ids: [seg], scope: 'all' })).toMatchObject({ aspects: [16 / 9] })
    expect(host.api.query({ where: [{ op: 'eq', kind: 'anchor', field: 'target', value: video }] })).toMatchObject({ ids: [seg] })

    host.api.trash([video])
    expect(host.store.isTrashed(seg)).toBe(true)
  })

  it('批注插件停用：视频插件照常装配，只是不再为片段截帧；片段的代表图和加工记录都留着', async () => {
    const a = setup()
    const [video] = await a.host.api.ingest([{ type: 'file', path: mp4 }])
    await a.host.scheduler.idle()
    const seg = a.host.api.create(segment(video)) as string
    await a.host.scheduler.idle()
    a.host.api.setPlugins(['annotate'])
    a.host.close()

    const b = openHost(undefined, { concurrency: 4 }, a.root)
    cleanups.push(b.cleanup)
    expect(b.host.plan.off.get('annotate')).toBe('已停用')
    const systems = b.host.reg.systems.map((s) => s.id)
    expect(systems).toContain('video.still')
    expect(systems).not.toContain('video.segment')
    await b.host.scheduler.idle()
    expect(b.host.store.blocksOf(seg).still.data.at).toBe(3)
    expect(b.host.lib.db.prepare(`SELECT count(*) AS n FROM derived.derivation WHERE system = 'video.segment'`).get()).toEqual({ n: 1 })
  })
})
