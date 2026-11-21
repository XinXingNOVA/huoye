import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { useEffect, useMemo, useState } from 'react'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import type { TabProps, UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { useEntityState } from '@resource-manager/plugin-api/ui/data'
import { ResourceCover } from '@resource-manager/plugin-api/ui/media'
import { useKeys } from '@resource-manager/plugin-api/ui/hooks'
import { formatDuration } from '@resource-manager/plugin-api/ui/widgets'
import { MusicProvider, trackInfo, useIds, useMusic, useSession } from './runtime'
import { MusicNavigation, LyricsPanel, QueuePanel } from './panels'
import { MusicIcon, LyricsIcon, QueueIcon } from './icons'
import { addToPlaylist, deletePlaylist, editLyrics, editTrack, playlistDialog } from './dialogs'
import './style.css'

const uiText = packageMessages('music')


const DRAG = 'application/x-rm-music-track'
function MusicTab({ host, params, active, saved, setState, setParams, setFocus, expose, registerKeys }: TabProps<Record<string, unknown>, { search?: string }>) {
  useUiLocale()
  const session = useMusic()
  const playlistId = typeof params.playlist === 'string' ? params.playlist : undefined
  const playlist = useEntityState(playlistId), data = playlist.view?.blocks.musicPlaylist?.data
  const [search, setSearch] = useState(saved?.search ?? ''), [query, setQuery] = useState(search)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const all = useIds(host, 'audio', query)
  const tracks = data?.tracks as string[] | undefined
  const ids = useMemo(() => playlistId ? (tracks ?? []).filter(id => !query || all.ids.includes(id)) : all.ids, [playlistId, tracks, query, all.ids])
  const available = useMemo(() => new Set(all.ids), [all.ids])
  const playable = ids.filter(id => available.has(id))
  const artwork = useEntityState(playable[0]).view
  const title = playlistId ? String(data?.title ?? uiText("歌单")) : uiText("全部歌曲")
  const picked = [...selected].filter(id => ids.includes(id))
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 180); setState({ search }); return () => clearTimeout(timer) }, [search, setState])
  useEffect(() => { setSelected(new Set()); setSearch('') }, [playlistId])
  useEffect(() => { if (active) setFocus(picked) }, [active, selected, ids, setFocus])
  useEffect(() => {
    if (!active || !Array.isArray(params.playIds)) return
    const queue = params.playIds.filter((id): id is string => typeof id === 'string')
    if (queue.length) session.playQueue(queue, queue[0])
    setParams({ playlist: params.playlist })
  }, [active, params, session, setParams])
  useEffect(() => {
    expose({ selectAll: () => setSelected(new Set(playable)), exportable: () => ({ ids: picked.length ? picked : playable, name: title }) })
    return () => expose(null)
  }, [ids, selected, title, expose])
  useKeys(registerKeys, e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    if (e.key === ' ') { session.toggle(); return true }
    return false
  })
  const run = (command: string, args: Record<string, unknown>) => {
    setError(''); void host.core.run('music', command, args).catch(e => setError(String(e)))
  }
  return <section className="music-page">
    <header className="music-page-head">
      <div className="music-album-art">{artwork?.blocks.thumb ? <ResourceCover view={artwork} host={host}/> : <span>♫</span>}</div>
      <div className="music-page-heading"><span className="music-eyebrow">{playlistId ? uiText("我的歌单") : uiText("音乐库")}</span><h1>{title}</h1>
        <p>{ids.length}{' '}{uiText("首歌曲")}{playlistId ? uiText(" · 自由编排你的聆听顺序") : uiText(" · 从收藏的声音里，找到今天的节奏")}</p>
        <div className="music-head-actions">
          <button className="music-primary" disabled={!playable.length} onClick={() => session.playQueue(playable, playable[0])}>{uiText("▶ 播放全部")}</button>
          <button className="small music-show-lyrics" onClick={() => host.showView('music.lyrics')}><LyricsIcon/>{uiText("歌词与播放控制")}</button>
          {playlistId && data ? <><button className="small" onClick={() => playlistDialog(host, playlistId, title)}>{uiText("重命名")}</button><button className="small" onClick={() => deletePlaylist(host, playlistId, title)}>{uiText("删除歌单")}</button></> : <button className="small" onClick={() => playlistDialog(host)}>{uiText("＋ 新建歌单")}</button>}
        </div>
      </div>
    </header>
    <div className="music-list-toolbar"><input type="search" aria-label={uiText("搜索歌曲")} placeholder={uiText("搜索曲名、艺术家、专辑或歌词…")} value={search} onChange={e => setSearch(e.target.value)}/>
      {picked.length > 0 && <><span>{picked.length}{' '}{uiText("首")}</span><button className="small" onClick={() => addToPlaylist(host, picked)}>{uiText("加入歌单")}</button><button className="small" onClick={() => session.enqueue(picked)}>{uiText("加入队列")}</button>{playlistId && <button className="small" onClick={() => run('removeTracks', { id: playlistId, tracks: picked })}>{uiText("移出歌单")}</button>}</>}
    </div>
    {error || all.error || playlist.error ? <p role="alert" className="music-error">{error || all.error || playlist.error}</p> : null}
    <div className="music-song-list" role="table" aria-label={title}>
      <div className="music-song-head" role="row"><span><input type="checkbox" aria-label={uiText("选择全部歌曲")} checked={playable.length > 0 && playable.every(id => selected.has(id))} onChange={e => setSelected(new Set(e.target.checked ? playable : []))}/></span><span>{uiText("歌曲 / 艺术家")}</span><span className="music-album-column">{uiText("专辑")}</span><span>{uiText("时长")}</span><span/></div>
      {ids.map((id, index) => <SongRow key={id} id={id} index={index} host={host} selected={selected.has(id)} playlist={playlistId}
        onSelect={() => setSelected(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next })}
        onPlay={() => session.playQueue(playable, id)}
        onMove={track => { if (track !== id && playlistId) run('moveTrack', { id: playlistId, track, before: id }) }}
        onShift={delta => {
          if (!playlistId || !tracks) return
          const at = tracks.indexOf(id), dest = at + delta
          if (dest >= 0 && dest < tracks.length) run('moveTrack', { id: playlistId, track: id, before: delta < 0 ? tracks[dest] : tracks[dest + 1] ?? null })
        }}
      />)}
      {!ids.length && <div className="music-empty"><span>♫</span><h3>{all.loading || (playlistId && playlist.status === 'loading') ? uiText("正在读取…") : playlist.error ? uiText("歌单读取失败") : playlistId && !data ? uiText("这份歌单已不存在") : uiText("这里还没有歌曲")}</h3><p>{query ? uiText("换一个关键词试试。") : playlistId ? uiText("在全部歌曲中多选，再加入这份歌单。") : uiText("将音频文件拖进仓库，解析完成后会出现在这里。")}</p></div>}
    </div>
  </section>
}
function SongRow({ id, index, host, selected, playlist, onSelect, onPlay, onMove, onShift }: {
  id: string; index: number; host: UiHost; selected: boolean; playlist?: string; onSelect(): void; onPlay(): void; onMove(id: string): void; onShift(delta: number): void
}) {
  useUiLocale()
  const state = useEntityState(id), view = state.view, session = useMusic(), playing = useSession()
  const info = trackInfo(view, host), available = view && !view.deletedAt && view.blocks.audio
  const current = playing.queue[playing.index] === id
  const menu = async () => {
    const action = await host.contextMenu([
      ...(available ? [{ id: 'play', label: uiText("播放") }, { id: 'next', label: uiText("下一首播放") }, { id: 'queue', label: uiText("加入播放队列") }, { id: 'add', label: uiText("加入歌单…") }, { id: 'lyrics', label: uiText("编辑歌词…") }, { id: 'edit', label: uiText("修正歌曲信息…") }] : []),
      ...(playlist ? [{ id: 'up', label: uiText("上移一首") }, { id: 'down', label: uiText("下移一首") }, { id: 'remove', label: uiText("从歌单移除（保留歌曲）") }] : []),
      { id: 'details', label: uiText("查看素材详情") }
    ])
    if (action === 'play') onPlay()
    if (action === 'next') session.enqueue([id], true)
    if (action === 'queue') session.enqueue([id])
    if (action === 'add') addToPlaylist(host, [id])
    if (action === 'lyrics' && view) editLyrics(host, view)
    if (action === 'edit' && view) editTrack(host, view)
    if (action === 'up') onShift(-1)
    if (action === 'down') onShift(1)
    if (action === 'remove') void host.core.run('music', 'removeTracks', { id: playlist, tracks: [id] }).catch(e => host.notify(String(e)))
    if (action === 'details') host.openData(id)
  }
  return <div className={`music-song${selected ? ' selected' : ''}${current ? ' current' : ''}${!available ? ' unavailable' : ''}`} role="row" data-track-id={id}
    draggable={!!playlist} onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData(DRAG, id); e.dataTransfer.effectAllowed = 'move' }}
    onDragOver={e => { if (playlist && e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); e.stopPropagation() } }}
    onDrop={e => { const track = e.dataTransfer.getData(DRAG); if (track) { e.preventDefault(); e.stopPropagation(); onMove(track) } }}
    onContextMenu={e => { e.preventDefault(); void menu() }} onDoubleClick={() => { if (available) onPlay() }}>
    <div role="cell"><input type="checkbox" aria-label={uiText("选择 {title}", { title: String(info.title) })} checked={selected} disabled={!available} onChange={onSelect}/></div>
    <div className="music-song-name" role="cell"><button className={`music-row-play${current && playing.playing ? ' is-playing' : ''}`} aria-label={uiText("播放 {title}", { title: String(info.title) })} disabled={!available} onClick={onPlay}>
      {view?.blocks.thumb ? <ResourceCover view={view} host={host}/> : <span className="music-row-number">{index + 1}</span>}
      <span className="music-row-play-symbol" aria-hidden="true">{current && playing.playing ? '♫' : '▶'}</span>
    </button><div><strong>{state.status === 'loading' ? uiText("读取中…") : info.title}</strong><small>{available ? info.artist : uiText("暂不可用 · 保留在歌单中")}</small></div></div>
    <div className="music-album-column music-ellipsis" role="cell">{info.album || '—'}</div><div role="cell" className="music-duration">{available ? formatDuration(info.duration) : '—'}</div>
    <button className="music-row-menu" aria-label={uiText("{title}的操作", { title: String(info.title) })} onClick={() => void menu()}>···</button>
  </div>
}

export const plugin: UiPlugin = {
  id: 'music',
  windowProviders: [{ id: 'music.session', order: 50, Component: MusicProvider }],
  toolViews: [
    { id: 'music.library', get title() { return uiText("音乐") }, Icon: MusicIcon, placement: { regions: ['left', 'center', 'right'], default: { region: 'left', group: 'music.navigation' } }, order: 50, Component: MusicNavigation },
    { id: 'music.lyrics', get title() { return uiText("歌词") }, Icon: LyricsIcon, placement: { regions: ['left', 'center', 'right'], default: { region: 'right', group: 'music.tools' } }, order: 50, Component: LyricsPanel },
    { id: 'music.queue', get title() { return uiText("队列") }, Icon: QueueIcon, placement: { regions: ['left', 'center', 'right'], default: { region: 'right', group: 'music.tools' } }, order: 60, Component: QueuePanel }
  ],
  views: [{ id: 'music.home', get title() { return uiText("音乐") }, query: { has: ['audio'] }, tab: 'music.player', order: 21 }],
  tabTypes: [{ id: 'music.player', key: () => 'music', Title: () => <>{uiText("音乐")}</>, Component: MusicTab }],
  actions: [
    { id: 'music.play', get title() { return uiText("在音乐播放器中播放") }, group: 10, order: 15, when: views => views.every(v => !!v.blocks.audio), run: (views, host) => host.openTab('music.player', { playIds: views.map(v => v.id) }) },
    { id: 'music.add', get title() { return uiText("加入歌单…") }, group: 20, order: 60, when: views => views.every(v => !!v.blocks.audio), run: (views, host) => addToPlaylist(host, views.map(v => v.id)) }
  ],
  sections: [{ id: 'music.info', get title() { return uiText("音乐") }, order: 22, kinds: ['musicTrack', 'musicLyrics'], match: v => !!v.blocks.audio, Component: MusicSection }]
}
function MusicSection({ view, host }: { view: EntityView; host: UiHost }) {
  useUiLocale()
  return <div className="music-section"><button className="small" onClick={() => editTrack(host, view)}>{uiText("修正歌曲信息")}</button><button className="small" onClick={() => editLyrics(host, view)}>{uiText("编辑歌词")}</button></div>
}
