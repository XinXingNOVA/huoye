import { rename, rm, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { ProcessorSystem } from '../../plugin-api/core/contracts'
import { run } from '../../plugin-api/core/process'
import { coverStreams } from './probe'

/** 音频只负责取出代表图；缩略图和色板仍由预览插件处理。新 System 会补扫已有歌曲。 */
export const audioCover: ProcessorSystem = {
  id: 'audio.still', priority: 13, has: ['file', 'audio'], inputs: ['file.hash'], needs: ['preview'],
  requires: { capabilities: ['media.inspect@1'], programs: ['ffmpeg'] },
  outputs: ['still'], concurrency: 2,
  async run(ctx, id, b) {
    const input = ctx.abs(String(b.file.data.path))
    const probe = await ctx.capabilities.run('media.inspect@1', { id, fileSeq: b.file.seq })
    const streams = coverStreams(probe)
    if (!streams.length) return { still: null }
    const rel = posix.join(ctx.cacheDir('audio-covers'), `${id}.jpg`), dest = ctx.abs(rel), temp = `${dest}.part`
    let failure: unknown
    try {
      for (const index of streams) {
        try {
          const image = await run(ctx.program('ffmpeg'), [
            '-v', 'error', '-i', input, '-map', `0:${index}`, '-an', '-frames:v', '1',
            '-vf', "scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease",
            '-c:v', 'mjpeg', '-q:v', '2', '-threads', '2', '-f', 'image2pipe', 'pipe:1'
          ], { signal: ctx.signal })
          if (!image.length) throw new Error('内嵌封面没有可解码的图像')
          await writeFile(temp, image)
          if (ctx.signal.aborted) throw new Error('已取消')
          await rename(temp, dest)
          return { still: { path: rel, source: b.file.seq } }
        } catch (e) {
          if (ctx.signal.aborted) throw e
          failure = e // 某张图片损坏时，继续尝试其他内嵌图。
        }
      }
      throw new Error(`无法读取内嵌封面：${failure instanceof Error ? failure.message : String(failure)}`)
    } finally { await rm(temp, { force: true }) }
  }
}
