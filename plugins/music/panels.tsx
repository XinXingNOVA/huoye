import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import { formatDuration } from '@resource-manager/plugin-api/ui/widgets'
import { useClock, useIds, useMusic, useSession, trackInfo } from './runtime'
import { currentLine, parseLyrics } from './lyrics'
import { editLyrics, playlistDialog, deletePlaylist } from './dialogs'
import { MusicIcon, QueueIcon, PreviousIcon, NextIcon, PlayIcon, PauseIcon, VolumeIcon } from './icons'
import { LyricCandidates } from './lyric-matching'

const uiText = packageMessages('music')


export function MusicNavigation({ host }: { host: UiHost }) {
  useUiLocale()
  const list = useIds(host, 'musicPlaylist')
  return <nav className="music-navigation">
    <button className="music-nav-link" onClick={() => host.openTab('music.player', { playlist: null })}><MusicIcon/>{uiText("全部歌曲")}</button>
    <button className="music-nav-link" onClick={() => host.showView('music.queue')}><QueueIcon/>{uiText("播放队列")}</button>
    <div className="music-nav-title"><span>{uiText("我的歌单")}</span><button aria-label={uiText("新建歌单")} title={uiText("新建歌单")} onClick={() => playlistDialog(host)}>＋</button></div>
    <div className="music-nav-list">
      {list.ids.map(id => <PlaylistLink key={id} id={id} host={host}/>)}
      {!list.loading && !list.ids.length && <p className="music-hint">{uiText("把喜欢的歌曲放在一起。")}<br/>{uiText("点击 ＋ 创建第一份歌单。")}</p>}
      {list.error && <p role="alert">{list.error}</p>}
    </div>
  </nav>
}
function PlaylistLink({ id, host }: { id: string; host: UiHost }) {
  useUiLocale()
  const view = useEntity(id), data = view?.blocks.musicPlaylist?.data
  if (!data) return null
  return <button className="music-nav-link" data-playlist-id={id} onClick={() => host.openTab('music.player', { playlist: id })}
    onDragOver={e => e.preventDefault()} onDrop={e => {
      const tracks = host.idsFromDrop(e.dataTransfer)
      if (!tracks.length) return
      e.preventDefault(); e.stopPropagation()
      void host.core.run('music', 'addTracks', { id, tracks }).then(() => host.notify(uiText("已加入歌单"))).catch(e => host.notify(String(e)))
    }}
    onContextMenu={async e => {
      e.preventDefault()
      const command = await host.contextMenu([{ id: 'rename', label: uiText("重命名歌单") }, { id: 'delete', label: uiText("删除歌单（保留歌曲）"), danger: true }])
      if (command === 'rename') playlistDialog(host, id, String(data.title))
      if (command === 'delete') deletePlaylist(host, id, String(data.title))
    }}><QueueIcon/><span className="music-ellipsis">{String(data.title)}</span><small>{(data.tracks as string[]).length}</small></button>
}
export function LyricsPanel({ host, active }: { host: UiHost; active: boolean }) {
  useUiLocale()
  const state = useSession(), clock = useClock(active), session = useMusic()
  const id = state.queue[state.index], view = useEntity(id)
  const raw = String(view?.blocks.musicLyrics?.data.text ?? '')
  const parsed = useMemo(() => parseLyrics(raw), [raw])
  const offset = parsed.offset + Number(view?.blocks.musicLyrics?.data.offset ?? 0)
  const current = currentLine(parsed.lines, clock.time - offset)
  const [follow, setFollow] = useState(true), scroller = useRef<HTMLDivElement>(null)
  const info = trackInfo(view, host)
  useEffect(() => setFollow(true), [id])
  useEffect(() => {
    if (!active || !follow || current < 0) return
    const container = scroller.current, line = container?.querySelector<HTMLElement>(`[data-line="${current}"]`)
    if (container && line) container.scrollTo({ top: line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [current, follow, active])
  return <section className="music-lyrics" aria-label={uiText("同步歌词")}>
    <header><span className="music-eyebrow">{state.playing ? uiText("正在聆听") : uiText("音乐")}</span><h2>{id ? info.title : uiText("让音乐开始")}</h2><p>{id ? info.artist : uiText("选择一首歌曲，歌词会在这里展开")}</p></header>
    <div className="music-lyric-scroll" ref={scroller} onWheel={() => setFollow(false)} onTouchStart={() => setFollow(false)} onPointerDown={() => setFollow(false)} onKeyDown={e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) setFollow(false) }} tabIndex={0}>
      {parsed.lines.length ? <div className="music-lines">{parsed.lines.map((line, i) => <button key={i} data-line={i}
        className={current >= 0 && line.time === parsed.lines[current].time ? 'current' : ''}
        aria-current={i === current ? 'true' : undefined}
        onClick={() => { session.seek(line.time + offset); setFollow(true) }}>{line.text}</button>)}</div>
        : parsed.plain ? <p className="music-plain">{parsed.plain}</p> : <LyricCandidates host={host}/>}
    </div>
    <div className="music-lyric-actions">{!follow && parsed.lines.length > 0 && <button className="small" onClick={() => setFollow(true)}>{uiText("回到当前歌词")}</button>}
      {view && !view.deletedAt && <button className="small" onClick={() => editLyrics(host, view)}>{raw ? uiText("编辑歌词 / 校时") : uiText("添加歌词")}</button>}
    </div>
    <PlaybackControls active={active}/>
  </section>
}
export function QueuePanel({ host }: { host: UiHost }) {
  useUiLocale()
  const state = useSession()
  return <section className="music-queue"><header><h2>{uiText("播放队列")}{' '}<small>{state.queue.length}</small></h2><p>{uiText("临时编排，独立于歌单保存。")}</p></header>
    <div className="music-queue-list">{state.queue.map((id, index) => <QueueRow key={id} host={host} id={id} index={index} current={index === state.index}/>)}
      {!state.queue.length && <p className="music-hint">{uiText("播放歌曲，或将歌曲加入队列。")}</p>}</div>
  </section>
}
function QueueRow({ host, id, index, current }: { host: UiHost; id: string; index: number; current: boolean }) {
  useUiLocale()
  const view = useEntity(id), session = useMusic(), info = trackInfo(view, host)
  return <div className={`music-queue-row${current ? ' current' : ''}`}>
    <button onClick={() => session.jump(index)}><span>{current ? '♫' : index + 1}</span><div><strong>{info.title}</strong><small>{view?.deletedAt ? uiText("已在回收站") : info.artist}</small></div></button>
    <button aria-label={uiText("从队列移除 {title}", { title: String(info.title) })} onClick={() => session.remove(index)}>×</button>
  </div>
}
function PlaybackControls({ active }: { active: boolean }) {
  useUiLocale()
  const session = useMusic(), state = useSession(), clock = useClock(active)
  const empty = !state.queue.length
  return <footer className="music-playback-controls" aria-label={uiText("音乐播放控制")}>
    <div className="music-timeline"><span>{formatDuration(clock.time)}</span><input aria-label={uiText("音乐进度")} type="range" min="0" max={clock.duration || 1} step="0.1" value={Math.min(clock.time, clock.duration || 1)} disabled={!clock.duration} onChange={e => session.seek(Number(e.target.value))}/><span>{formatDuration(clock.duration)}</span></div>
      <div className="music-transport">
        <button aria-label={uiText("上一首")} title={uiText("上一首")} disabled={empty} onClick={session.previous}><PreviousIcon/></button>
        <button className="music-play" aria-label={state.playing ? uiText("暂停音乐") : uiText("播放音乐")} disabled={empty} onClick={session.toggle}>{state.playing ? <PauseIcon/> : <PlayIcon/>}</button>
        <button aria-label={uiText("下一首")} title={uiText("下一首")} disabled={empty} onClick={() => session.next()}><NextIcon/></button>
      </div>
    <div className="music-playback-options">
      <select aria-label={uiText("播放模式")} value={state.mode} onChange={e => session.mode(e.target.value as typeof state.mode)}>
        <option value="sequence">{uiText("顺序播放")}</option><option value="shuffle">{uiText("随机播放")}</option><option value="repeat">{uiText("单曲循环")}</option>
      </select>
      <label className="music-volume" title={uiText("音量 {value1}%", { value1: String(Math.round(state.volume * 100)) })}><VolumeIcon/><input aria-label={uiText("音乐音量")} type="range" min="0" max="1" step="0.01" value={state.volume} onChange={e => session.volume(Number(e.target.value))}/></label>
    </div>
    {state.error && <p className="music-error" role="alert">{state.error}</p>}
  </footer>
}
