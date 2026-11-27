import { playbackCommand } from '../../plugin-api/core/playback'
import { rename, rm } from 'node:fs/promises'
import { posix } from 'node:path'
import type { CorePlugin } from '../../plugin-api/core/contracts'
import { run } from '../../plugin-api/core/process'
import { AUDIO_EXTS, blocks } from './blocks'
import { parseProbe } from './probe'
import { audioCover } from './cover'

export const plugin: CorePlugin = {
  id: 'audio', version: 1, blocks,
  dataLifecycle: { version: 1, disposableRecords: [], retainedEffects: [] },
  commands: { recordPlayback: playbackCommand('audio', 'audioPlayback') },
  systems: [
    audioCover,
    {
      id: 'audio.probe', requires: { capabilities: ['media.inspect@1'] }, priority: 0, has: ['file'], inputs: ['file.hash'],
      match: b => AUDIO_EXTS.has(String(b.file.data.ext)), outputs: ['audio'], concurrency: 2,
      async run(ctx, id, b) {
        const media = await ctx.capabilities.run('media.inspect@1', { id, fileSeq: b.file.seq })
        return { audio: parseProbe(media, String(b.file.data.ext)) }
      }
    },
    {
      // 只在打开不兼容的音频或用户主动转换时运行；不改变原文件。
      id: 'audio.proxy', requires: { programs: ['ffmpeg'] }, priority: 90, has: ['file', 'audio'], inputs: ['file.hash'],
      outputs: ['audioProxy'], demand: true, concurrency: 1,
      async run(ctx, id, b) {
        const rel = posix.join(ctx.cacheDir('audio'), `${id}.m4a`)
        const dest = ctx.abs(rel)
        const temp = `${dest}.part`
        const duration = Number(b.audio.data.duration)
        try {
          await run(ctx.program('ffmpeg'), [
            '-v', 'error', '-y', '-i', ctx.abs(String(b.file.data.path)), '-map', '0:a:0', '-vn',
            '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-threads', '2',
            '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', temp
          ], {
            signal: ctx.signal,
            onLine: line => {
              if (line.startsWith('out_time_us=') && duration > 0) {
                const t = Number(line.slice(12)) / 1_000_000
                if (Number.isFinite(t)) ctx.progress(Math.min(1, t / duration))
              }
            }
          })
          if (ctx.signal.aborted) throw new Error('已取消')
          await rename(temp, dest)
          return { audioProxy: { path: rel, source: String(b.file.data.hash) } }
        } finally { await rm(temp, { force: true }) }
      }
    }
  ],
  aspect: {
    priority: 25,
    get: b => b.audio && b.thumb ? Number(b.thumb.data.width) / Number(b.thumb.data.height) : undefined
  }
}
