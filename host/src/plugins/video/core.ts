import { playbackCommand } from '../../plugin-api/core/playback'
// 视频插件：读元数据、截代表图、生成悬停预览帧、按需转出播放代理。
// 实测耗时见设计文档 11.3。

import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { posix } from 'node:path'
import sharp from 'sharp'
import type { CorePlugin, JobContext } from '../../plugin-api/core/contracts'
import type { Blocks } from '../../shared/blocks'
import { blocks, VIDEO_EXTS } from './blocks'
import { codecsPlayable, parseProbe, type Probe } from './lib/probe'
import { run } from './lib/run'

const FRAME_COUNT = 20
const FRAME_WIDTH = 240
/** 不超过这个时长的视频整段解码一次取帧；更长的逐帧跳转（耗时与时长无关）。 */
const SINGLE_PASS_MAX = 90

const input = (ctx: JobContext, b: Blocks) => ctx.abs(String(b.file.data.path))
const durationOf = (b: Blocks) => Number(b.video.data.duration) || 0

async function grabFrame(ctx: JobContext, src: string, at: number, width: string): Promise<Buffer> {
  return run(
    ctx.program('ffmpeg'),
    ['-v', 'error', '-threads', '2', '-ss', at.toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', '-'],
    { signal: ctx.signal }
  )
}

export const videoPlugin: CorePlugin = {
  id: 'video',
  version: 1,
  requires: { programs: ['ffmpeg', 'ffprobe'] },
  blocks,
  dataLifecycle: { version: 1, disposableRecords: [], retainedEffects: [] },
  commands: { recordPlayback: playbackCommand('video', 'videoPlayback') },
  systems: [
    {
      id: 'video.probe',
      priority: 0,
      has: ['file'],
      // 只看文件的内容：改名不重做（设计文档 11.14）
      inputs: ['file.hash'],
      match: (b) => VIDEO_EXTS.has(String(b.file.data.ext)),
      outputs: ['video'],
      async run(ctx, _id, b) {
        const out = await run(
          ctx.program('ffprobe'),
          ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input(ctx, b)],
          { signal: ctx.signal }
        )
        return { video: parseProbe(JSON.parse(out.toString()) as Probe) }
      }
    },
    {
      // 代表图：取第 10% 处的一帧，避开片头黑场
      id: 'video.still',
      priority: 12,
      has: ['file', 'video'],
      inputs: ['file.hash'],
      outputs: ['still'],
      concurrency: 2,
      async run(ctx, id, b) {
        const at = durationOf(b) > 1 ? durationOf(b) * 0.1 : 0
        let jpg = await grabFrame(ctx, input(ctx, b), at, "'min(1280,iw)'")
        if (jpg.length === 0 && at > 0) jpg = await grabFrame(ctx, input(ctx, b), 0, "'min(1280,iw)'")
        if (jpg.length === 0) throw new Error('截不到画面')
        const rel = posix.join(ctx.cacheDir('stills'), `${id}.jpg`)
        await sharp(jpg).toFile(ctx.abs(rel))
        return { still: { path: rel, source: b.file.seq, at } }
      }
    },
    {
      // 时间段锚点（批注插件的局部）：截起点那一帧作局部的代表图。
      // 锚点类型由原素材的媒体插件服务（设计文档 11.2）；批注插件没有启用时不装配
      id: 'video.segment',
      priority: 15,
      has: ['anchor'],
      needs: ['annotate'],
      // 原视频的内容换了，重新截（只是改名不算）
      targetInputs: ['file.hash'],
      match: (b) => b.anchor.data.type === '时间段',
      outputs: ['still'],
      concurrency: 2,
      async run(ctx, id, b) {
        const a = b.anchor.data
        const target = ctx.blocksOf(String(a.target))
        if (!target.file || !target.video) throw new Error('原素材不是视频')
        const at = Math.max(0, Number(a.start) || 0)
        const jpg = await grabFrame(ctx, input(ctx, target), at, "'min(1280,iw)'")
        if (jpg.length === 0) throw new Error('截不到画面')
        const rel = posix.join(ctx.cacheDir('locals'), `${id}.jpg`)
        await sharp(jpg).toFile(ctx.abs(rel))
        // 锚点和原视频文件的序号之和：任何一个变了都会变（见 annotate.still）
        return { still: { path: rel, source: b.anchor.seq + target.file.seq, at } }
      }
    },
    {
      id: 'video.frames',
      priority: 70,
      has: ['file', 'video'],
      inputs: ['file.hash'],
      outputs: ['frames'],
      concurrency: 1,
      async run(ctx, id, b) {
        const d = durationOf(b)
        if (d <= 0) throw new Error('时长未知')
        const src = input(ctx, b)
        const rel = posix.join(ctx.cacheDir('frames'), `${id}.jpg`)
        const out = ctx.abs(rel)

        if (d <= SINGLE_PASS_MAX) {
          await run(
            ctx.program('ffmpeg'),
            ['-v', 'error', '-y', '-threads', '2', '-i', src, '-vf', `fps=${FRAME_COUNT}/${d},scale=${FRAME_WIDTH}:-2,tile=${FRAME_COUNT}x1`, '-frames:v', '1', '-q:v', '4', out],
            { signal: ctx.signal }
          )
        } else {
          const tiles: Buffer[] = []
          for (let i = 0; i < FRAME_COUNT; i++) {
            tiles.push(await grabFrame(ctx, src, ((i + 0.5) * d) / FRAME_COUNT, String(FRAME_WIDTH)))
            ctx.progress((i + 1) / FRAME_COUNT)
          }
          const first = await sharp(tiles[0]).metadata()
          await sharp({ create: { width: FRAME_WIDTH * FRAME_COUNT, height: first.height!, channels: 3, background: '#000' } })
            .composite(tiles.filter((t) => t.length).map((t, i) => ({ input: t, left: i * FRAME_WIDTH, top: 0 })))
            .jpeg({ quality: 80 })
            .toFile(out)
        }

        const meta = await sharp(out).metadata()
        return {
          frames: { path: rel, count: FRAME_COUNT, tileWidth: FRAME_WIDTH, tileHeight: meta.height, source: b.file.seq }
        }
      }
    },
    {
      // 按需：不能直接播放的视频，播放前才转出 MP4。编码本身可播放时只换容器（几十毫秒），否则转码
      id: 'video.proxy',
      priority: 5,
      has: ['file', 'video'],
      inputs: ['file.hash'],
      match: (b) => !b.video.data.playable,
      outputs: ['proxy'],
      concurrency: 1,
      demand: true,
      async run(ctx, id, b) {
        const v = b.video.data
        const remux = codecsPlayable(String(v.codec), v.audio ? String(v.audio) : undefined)
        const rel = posix.join(ctx.cacheDir('proxy'), `${id}.mp4`)
        const part = ctx.abs(rel) + '.part'
        const d = durationOf(b)
        try {
          await run(
            ctx.program('ffmpeg'),
            [
              '-v', 'error', '-y', '-i', input(ctx, b),
              ...(remux
                ? ['-c', 'copy']
                : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k']),
              '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', part
            ],
            {
              signal: ctx.signal,
              onLine: (line) => {
                const m = /^out_time_us=(\d+)/.exec(line)
                if (m && d > 0) ctx.progress(Number(m[1]) / 1e6 / d)
              }
            }
          )
          await rename(part, ctx.abs(rel))
        } finally {
          if (existsSync(part)) await rm(part, { force: true })
        }
        return { proxy: { path: rel, mode: remux ? 'remux' : 'transcode', source: b.file.seq } }
      }
    }
  ],
  aspect: {
    priority: 10,
    get: (b) => {
      const v = b.video?.data
      return v ? Number(v.width) / Number(v.height) : undefined
    }
  }
}

export { videoPlugin as plugin }
