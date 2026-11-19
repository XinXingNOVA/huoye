import { readFile } from 'node:fs/promises'
import type { ProcessorSystem } from '@resource-manager/plugin-api/core/contracts'
import { decodeLyrics, lyricMetadata, MAX_LYRIC_BYTES } from './lyric-match'
import { parseLyrics } from './lyrics'

/** 原文件仍由仓库持有；此块只是可重建的本地匹配索引。 */
export const lyricIndex: ProcessorSystem = {
  id: 'music.lyric-index', priority: 30, has: ['file'], needs: ['file'], outputs: ['musicLyricSource'], concurrency: 2,
  match: b => ['lrc', 'txt'].includes(String(b.file.data.ext)),
  async run(ctx, _id, b) {
    const file = b.file.data
    const source = { hash: file.hash, name: file.name }
    try {
      if (Number(file.size) > MAX_LYRIC_BYTES) throw new Error('歌词文件不能超过 1 MB')
      const bytes = await readFile(ctx.abs(String(file.path)), { signal: ctx.signal })
      if (bytes.length > MAX_LYRIC_BYTES) throw new Error('歌词文件不能超过 1 MB')
      const text = decodeLyrics(bytes), meta = lyricMetadata(text, String(file.name))
      // 普通 TXT 不凭文件名当成歌词，须有时间戳或明确的歌词标题标记。
      const recognized = file.ext === 'lrc' || meta.tagged || parseLyrics(text).lines.length > 0
      return { musicLyricSource: { ...source, ...meta, text: recognized ? text : '', error: '' } }
    } catch (e) {
      if (ctx.signal.aborted) throw e
      return { musicLyricSource: { ...source, text: '', error: e instanceof Error ? e.message : String(e) } }
    }
  }
}
