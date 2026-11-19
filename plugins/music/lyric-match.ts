import type { Blocks } from '@resource-manager/plugin-api/blocks'
import { parseLyrics } from './lyrics'

export const MAX_LYRIC_BYTES = 1_000_000
export function decodeLyrics(bytes: ArrayBuffer | Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes) }
}
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
/** 保留 Live、伴奏、Remix 等版本文字，只统一大小写、全半角、空白和标点。 */
export const matchKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const stem = (name: string) => name.replace(/\.[^.]+$/, '')
export function lyricMetadata(text: string, filename: string) {
  const tag = (key: string) => text.match(new RegExp(`^\\s*\\[${key}:([^\\]\\r\\n]*)\\]`, 'im'))?.[1].trim() ?? ''
  const length = tag('length').match(/^(\d+):([0-5]\d)(?:\.(\d+))?$/)
  return { title: tag('ti') || stem(filename), artist: tag('ar'), album: tag('al'), tagged: !!tag('ti'),
    duration: length ? Number(length[1]) * 60 + Number(length[2]) + Number(`0.${length[3] ?? '0'}`) : 0 }
}
export function songMetadata(blocks: Blocks) {
  const base = blocks.audio?.data ?? {}, edited = blocks.musicTrack?.data ?? {}
  return { title: string(edited.title) || string(base.title) || stem(string(blocks.file?.data.name)),
    artist: string(edited.artist) || string(base.artist), album: string(edited.album) || string(base.album),
    duration: Number(base.duration) || 0, tagged: !!(string(edited.title) || string(base.title)) }
}
export interface LyricCandidate {
  id: string; token: string; title: string; artist: string; album: string; label: string
  reason: string; strong: boolean; synced: boolean; preview: string; offset: number
}
export interface LyricMatches {
  id: string; target: string; existing: boolean; pending: number; failed: number; candidates: LyricCandidate[]
}
export interface LyricSource {
  title: string; artist: string; album: string; duration: number; tagged: boolean
  text: string; offset: number; label: string
}
/** 只有标题相同才是候选；文件名还支持「已知歌手 - 曲名」。不做模糊猜测。 */
export function assessLyrics(song: ReturnType<typeof songMetadata>, source: LyricSource): { strong: boolean; reason: string } | undefined {
  const title = matchKey(song.title), artist = matchKey(song.artist), sourceArtist = matchKey(source.artist)
  if (!title) return
  const sameTitle = matchKey(source.title) === title
  const namedPair = !source.tagged && !!artist && source.title.split(/\s+[-–—]\s+/).some((part, i, parts) =>
    parts.length === 2 && matchKey(part) === title && matchKey(parts[1 - i]) === artist)
  if (!sameTitle && !namedPair) return
  if (artist && sourceArtist && artist !== sourceArtist) return
  if (song.album && source.album && matchKey(song.album) !== matchKey(source.album)) return { strong: false, reason: '曲名相同，专辑不同，请确认版本' }
  if (song.duration && source.duration && Math.abs(song.duration - source.duration) > 2) return { strong: false, reason: '曲名相同，时长不同，请确认版本' }
  if (!source.tagged || !song.tagged) return { strong: false, reason: '文件名匹配，请确认歌曲与版本' }
  if (!artist || !sourceArtist) return { strong: false, reason: '曲名相同，缺少歌手信息' }
  return { strong: true, reason: '曲名、歌手一致，未发现版本冲突' }
}
export function lyricPreview(text: string) {
  const parsed = parseLyrics(text)
  return { synced: parsed.lines.length > 0, preview: (parsed.lines.length ? parsed.lines.map(l => l.text).join('\n') : parsed.plain).slice(0, 240) }
}
