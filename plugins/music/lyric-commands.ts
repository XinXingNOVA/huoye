import { createHash } from 'node:crypto'
import type { Blocks } from '@resource-manager/plugin-api/blocks'
import type { CommandContext } from '@resource-manager/plugin-api/core/contracts'
import { assessLyrics, lyricPreview, songMetadata, type LyricMatches, type LyricSource } from './lyric-match'

const token = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const targetToken = (b: Blocks) => token(['file', 'audio', 'musicTrack', 'musicLyrics'].map(k => b[k] ?? null))
function sourceOf(b: Blocks): LyricSource | undefined {
  if (b.audio && String(b.musicLyrics?.data.text ?? '').trim()) {
    return { ...songMetadata(b), text: String(b.musicLyrics.data.text), offset: Number(b.musicLyrics.data.offset ?? 0),
      label: `歌曲「${songMetadata(b).title}」的歌词` }
  }
  const index = b.musicLyricSource?.data, file = b.file?.data
  if (!index || !file || !['lrc', 'txt'].includes(String(file.ext)) || index.hash !== file.hash || index.name !== file.name || !String(index.text ?? '').trim()) return
  return { title: String(index.title ?? ''), artist: String(index.artist ?? ''), album: String(index.album ?? ''),
    duration: Number(index.duration ?? 0), tagged: index.tagged === true, text: String(index.text), offset: 0, label: String(file.name) }
}
export function findLibraryLyrics(ctx: CommandContext, id: string): LyricMatches {
  if (!ctx.query({ scope: 'content', ids: [id], has: ['audio'] }).ids.length) throw new Error('歌曲已移除或不可用')
  const b = ctx.blocksOf(id)
  const result: LyricMatches = { id, target: targetToken(b), existing: !!b.musicLyrics, pending: 0, failed: 0, candidates: [] }
  if (result.existing) return result
  const song = songMetadata(b)
  const files = ['lrc', 'txt'].flatMap(ext => ctx.query({ scope: 'content', has: ['file'], where: [{ op: 'eq', kind: 'file', field: 'ext', value: ext }] }).ids)
  const fileIds = new Set(files)
  const attached = ctx.query({ scope: 'content', has: ['audio', 'musicLyrics'] }).ids
  for (const candidateId of new Set([...files, ...attached])) {
    if (candidateId === id) continue
    const candidate = ctx.blocksOf(candidateId)
    if (fileIds.has(candidateId)) {
      const index = candidate.musicLyricSource?.data, file = candidate.file.data
      if (!index || index.hash !== file.hash || index.name !== file.name) { result.pending++; continue }
      if (index.error) { result.failed++; continue }
    }
    const source = sourceOf(candidate)
    if (!source) continue
    const match = assessLyrics(song, source)
    if (!match) continue
    const preview = lyricPreview(source.text)
    if (!preview.synced && !preview.preview.trim()) continue
    result.candidates.push({ id: candidateId, token: token(source), title: source.title, artist: source.artist, album: source.album,
      label: source.label, offset: source.offset, ...preview, ...match })
  }
  result.candidates.sort((a, b) => Number(b.strong) - Number(a.strong) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  return result
}
/** 同步事务中重查目标与候选，迟到的结果不能覆盖编辑，也不能采用已经变化／回收的来源。 */
export function applyLibraryLyrics(ctx: CommandContext, args: Record<string, unknown>) {
  const id = String(args.id), matches = findLibraryLyrics(ctx, id)
  if (matches.existing) throw new Error('歌曲已有歌词，已保留原内容')
  if (matches.target !== args.target) throw new Error('歌曲信息已变化，请重新匹配')
  const candidate = matches.candidates.find(c => c.id === args.candidate && c.token === args.token)
  if (!candidate) throw new Error('候选歌词已变化或移除，请重新匹配')
  if (args.automatic === true && (matches.pending || matches.candidates.length !== 1 || !candidate.strong)) throw new Error('匹配结果不再唯一明确，请选择候选')
  const source = sourceOf(ctx.blocksOf(candidate.id))!
  ctx.put(id, 'musicLyrics', { text: source.text, offset: source.offset, source: source.label.slice(0, 300) })
  return { label: args.automatic === true ? '自动匹配仓库歌词' : '采用仓库歌词', result: { source: source.label } }
}
