import type { CommandContext, CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
import { lyricIndex } from './lyric-index'
import { findLibraryLyrics, applyLibraryLyrics } from './lyric-commands'

const text = (v: unknown, label: string, max = 300) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${label}不能为空且不能超过 ${max} 字`)
  return v.trim()
}
const ids = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > 10000 || v.some(x => typeof x !== 'string' || !x)) throw new Error('歌曲列表无效（最多 10000 项）')
  return [...new Set(v)]
}
function playlist(ctx: CommandContext, id: unknown) {
  if (typeof id !== 'string' || !ctx.query({ scope: 'all', ids: [id], has: ['musicPlaylist'] }).ids.length) throw new Error('歌单不存在')
  const data = ctx.blocksOf(id).musicPlaylist.data
  return { id, title: String(data.title), tracks: (data.tracks ?? []) as string[] }
}
function requireTracks(ctx: CommandContext, tracks: string[]) {
  if (!tracks.length || ctx.query({ scope: 'content', ids: tracks, has: ['audio'] }).ids.length !== tracks.length) throw new Error('请选择可用的音频素材')
}

export const plugin: CorePlugin = {
  id: 'music', version: 1, blocks,
  dataLifecycle: { version: 1, disposableRecords: ['musicPlaylist'], retainedEffects: ['本机队列和音量沿用 localStorage，本次仓库清理不移除。', '音频播放记录归音频功能管理，清理音乐插件不会清除播放记录。'] },
  systems: [lyricIndex],
  commands: {
    findLyrics(ctx, args) { return { label: '查找仓库歌词', result: findLibraryLyrics(ctx, text(args.id, '歌曲身份')) } },
    applyMatchedLyrics: applyLibraryLyrics,
    createPlaylist(ctx, args) {
      const title = text(args.title, '歌单名称'), tracks = ids(args.tracks ?? [])
      if (tracks.length) requireTracks(ctx, tracks)
      const id = ctx.createEntity()
      ctx.put(id, 'musicPlaylist', { title, tracks })
      return { label: `新建歌单「${title}」`, result: { id } }
    },
    renamePlaylist(ctx, args) {
      const p = playlist(ctx, args.id), title = text(args.title, '歌单名称')
      ctx.put(p.id, 'musicPlaylist', { title, tracks: p.tracks })
      return { label: '重命名歌单' }
    },
    deletePlaylist(ctx, args) {
      const p = playlist(ctx, args.id)
      ctx.deleteRecord(p.id)
      return { label: `删除歌单「${p.title}」` }
    },
    addTracks(ctx, args) {
      const p = playlist(ctx, args.id), add = ids(args.tracks)
      requireTracks(ctx, add)
      const tracks = [...new Set([...p.tracks, ...add])]
      if (tracks.length > 10000) throw new Error('歌单最多 10000 首')
      ctx.put(p.id, 'musicPlaylist', { title: p.title, tracks })
      return { label: '加入歌单' }
    },
    removeTracks(ctx, args) {
      const p = playlist(ctx, args.id), remove = new Set(ids(args.tracks))
      ctx.put(p.id, 'musicPlaylist', { title: p.title, tracks: p.tracks.filter(id => !remove.has(id)) })
      return { label: '从歌单移除歌曲' }
    },
    moveTrack(ctx, args) {
      const p = playlist(ctx, args.id)
      if (typeof args.track !== 'string' || !p.tracks.includes(args.track)) throw new Error('歌曲已不在歌单')
      const tracks = p.tracks.filter(id => id !== args.track)
      const target = args.before == null ? tracks.length : tracks.indexOf(String(args.before))
      if (target < 0) throw new Error('目标歌曲已不在歌单，请重试')
      tracks.splice(target, 0, args.track)
      ctx.put(p.id, 'musicPlaylist', { title: p.title, tracks })
      return { label: '调整歌单顺序' }
    },
    saveLyrics(ctx, args) {
      const id = text(args.id, '歌曲身份'); requireTracks(ctx, [id])
      if (typeof args.text !== 'string' || args.text.length > 1_000_000) throw new Error('歌词过长或格式无效')
      const offset = Number(args.offset ?? 0)
      if (!Number.isFinite(offset) || Math.abs(offset) > 600) throw new Error('时间偏移应在 -600 到 600 秒之间')
      ctx.put(id, 'musicLyrics', { text: args.text, offset, source: typeof args.source === 'string' ? args.source.slice(0, 300) : '' })
      return { label: '保存歌词' }
    },
    editTrack(ctx, args) {
      const id = text(args.id, '歌曲身份'); requireTracks(ctx, [id])
      const data: Record<string, string> = {}
      for (const field of ['title', 'artist', 'album']) {
        if (typeof args[field] !== 'string' || (args[field] as string).length > 500) throw new Error('歌曲信息无效或过长')
        if ((args[field] as string).trim()) data[field] = (args[field] as string).trim()
      }
      if (Object.keys(data).length) ctx.put(id, 'musicTrack', data)
      else if (ctx.blocksOf(id).musicTrack) ctx.remove(id, 'musicTrack')
      return { label: '修改歌曲信息' }
    }
  }
}
