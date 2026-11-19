import { useVideoPlayback } from './playback'
// 播放器标签页：视频插件提供的标签页类型，第一个"单素材"标签页（设计文档 10.4）。
// 双击视频卡片打开；带着打开它的列表，可以切到上一个 / 下一个。
// 播放位置在播放进度块里，不在标签页存档里（10.5）；标签页隐藏时暂停（10.2）。
// 开放时间轴作为叠加层（8.3）：批注插件在上面标记片段、显示已有的片段。

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { Query } from '../../shared/query'
import { useEntity } from '../../plugin-api/ui/data'
import { useKeys, useUiEffect } from '../../plugin-api/ui/hooks'
import { useNeighbors, type Neighbors } from '../../plugin-api/ui/navigation'
import type { KeyHandler, TabProps, TabType, UiHost } from '../../plugin-api/ui/contracts'
import { formatDuration } from '../../plugin-api/ui/widgets'
import { playableSource, useProxy } from './hooks'

export interface PlayerParams extends Record<string, unknown> {
  id: string
  /** 打开它的列表（当时标签页的有效查询）：上一个 / 下一个在这里面找。 */
  list?: Query
  /** 打开时定位到的身份（例如从片段的卡片打开：跳到它的起点并选中）。 */
  focus?: string
}

/** 存档：只记"已经开始过"。重启后恢复的播放器不自动播放。 */
interface PlayerState {
  started: true
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
const HOVER_FRAME_WIDTH = 160

/** 音量、倍速：跟着这台电脑走，不进素材库。 */
const pref = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`video.${key}`)
      return v === null ? fallback : (JSON.parse(v) as T)
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`video.${key}`, JSON.stringify(value))
    } catch {
      // 存不了就只在这次有效
    }
  }
}

function Player({ params, host, expose, active, saved, setState, setParams, setFocus, registerKeys }: TabProps<PlayerParams, PlayerState>) {
  const view = useEntity(params.id)
  const contextTitle = view ? host.title(view) : '视频播放页'
  useEffect(() => expose({ context: { title: contextTitle } }), [expose, contextTitle])
  const nav = useNeighbors(host, params.list, params.id, 'video')
  const autoplay = useRef(!saved)
  const [selected, setSelected] = useState(params.focus)
  // 从片段的卡片切过来（定位到别的身份）是要看的：跳过去后接着播。
  // 在渲染时判断，因为叠加层的定位在子组件的副作用里，先于这里的副作用运行
  const lastFocus = useRef(params.focus)
  if (params.focus !== lastFocus.current) {
    lastFocus.current = params.focus
    if (params.focus) autoplay.current = true
  }

  useEffect(() => setSelected(params.focus), [params.focus, params.id])
  // 焦点：选中的片段，或者这个视频本身。检查器跟着显示
  useEffect(() => setFocus([selected ?? params.id]), [selected, params.id, setFocus])
  useEffect(() => {
    if (!saved) setState({ started: true })
  }, [saved, setState])

  const go = (id: string | undefined) => {
    if (!id) return
    autoplay.current = true
    setParams({ ...params, id, focus: undefined })
  }

  if (!view) return <Status>正在读取…</Status>
  if (view.deletedAt) {
    return (
      <Status>
        已移到回收站
        <button className="small" onClick={() => host.core.restore([view.id])}>
          恢复
        </button>
      </Status>
    )
  }
  if (!view.blocks.video) return <Status>不是视频</Status>
  return (
    <Stage
      view={view}
      host={host}
      active={active}
      autoplay={autoplay.current}
      registerKeys={registerKeys}
      nav={nav}
      go={go}
      selected={selected}
      select={setSelected}
      revealId={params.focus}
    />
  )
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="player">
      <div className="player-stage">
        <div className="player-status">{children}</div>
      </div>
    </div>
  )
}

type Nav = Neighbors

interface StageProps {
  view: EntityView
  host: UiHost
  active: boolean
  autoplay: boolean
  registerKeys(h: KeyHandler | null): void
  nav: Nav
  go(id: string | undefined): void
  selected?: string
  select(id: string | undefined): void
  revealId?: string
}

function Stage({ view, host, active, autoplay, registerKeys, nav, go, selected, select, revealId }: StageProps) {
  const src = playableSource(view)
  const { progress, error } = useProxy(host, view, !src)
  const ref = useRef<HTMLVideoElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [volume, setVolume] = useState(() => pref.get('volume', 1))
  const [muted, setMuted] = useState(() => pref.get('muted', false))
  const [rate, setRate] = useState(() => pref.get('rate', 1))
  const fps = Number(view.blocks.video.data.fps) || 25

  useVideoPlayback(ref, view, host, src?.seq)

  // 视频还没读好时要跳转（例如从片段打开）：读好后再跳。
  // 排在播放记录后面登记，所以盖过"从上次的位置继续"
  const pendingSeek = useRef<number | undefined>(undefined)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onLoaded = () => {
      if (pendingSeek.current === undefined) return
      el.currentTime = Math.max(0, Math.min(el.duration, pendingSeek.current))
      pendingSeek.current = undefined
    }
    if (el.readyState >= 1) onLoaded()
    el.addEventListener('loadedmetadata', onLoaded)
    return () => el.removeEventListener('loadedmetadata', onLoaded)
  }, [view.id, src?.seq])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.volume = volume
    el.muted = muted
    el.playbackRate = rate
  }, [volume, muted, rate, view.id, src?.seq])
  useEffect(() => pref.set('volume', volume), [volume])
  useEffect(() => pref.set('muted', muted), [muted])
  useEffect(() => pref.set('rate', rate), [rate])
  useEffect(() => setEnded(false), [view.id])

  // 标签页隐藏时暂停；切回来不自动继续
  useEffect(() => {
    if (!active) ref.current?.pause()
  }, [active])

  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }
  const seek = useCallback((t: number) => {
    const el = ref.current
    if (el && el.readyState >= 1 && el.duration) el.currentTime = Math.max(0, Math.min(el.duration, t))
    else pendingSeek.current = t
  }, [])
  const play = useCallback(() => void ref.current?.play(), [])
  const pause = useCallback(() => ref.current?.pause(), [])
  /**
   * 定位到某一时刻：跳过去接着播。重启后恢复的标签页不定位，从上次看到的地方继续（选中还在）。
   */
  const reveal = (t: number) => {
    if (!autoplay) return
    seek(t)
    play()
  }
  const seekBy = (d: number) => seek((ref.current?.currentTime ?? 0) + d)
  const fullscreen = () => {
    const document = root.current?.ownerDocument
    if (document?.fullscreenElement) void document.exitFullscreen()
    else void root.current?.requestFullscreen()
  }
  const changeVolume = (d: number) => {
    setVolume((v) => Math.round(Math.max(0, Math.min(1, v + d)) * 10) / 10)
    setMuted(false)
  }

  // 叠加层的按键：每个叠加层一个固定的登记函数
  const overlayKeys = useRef(new Map<string, KeyHandler>())
  const overlayRegister = useMemo(() => {
    const fns = new Map<string, (h: KeyHandler | null) => void>()
    return (id: string) => {
      let fn = fns.get(id)
      if (!fn) {
        fn = (h) => (h ? overlayKeys.current.set(id, h) : overlayKeys.current.delete(id))
        fns.set(id, fn)
      }
      return fn
    }
  }, [])

  // 这类标签页的快捷键。先问叠加层；带 ⌘ / Ctrl 的留给窗口（⌘W、⌘1–9）
  useKeys(registerKeys, (e) => {
    for (const h of overlayKeys.current.values()) if (h(e)) return true
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    const el = ref.current
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    switch (key) {
      case ' ':
      case 'k':
        toggle()
        return true
      case 'ArrowLeft':
        seekBy(-5)
        return true
      case 'ArrowRight':
        seekBy(5)
        return true
      case 'j':
        seekBy(-10)
        return true
      case 'l':
        seekBy(10)
        return true
      case 'ArrowUp':
        changeVolume(0.1)
        return true
      case 'ArrowDown':
        changeVolume(-0.1)
        return true
      case 'm':
        setMuted((m) => !m)
        return true
      case 'f':
        fullscreen()
        return true
      case ',':
      case '.':
        // 暂停时逐帧
        if (el?.paused) seekBy((key === ',' ? -1 : 1) / fps)
        return true
      case 'n':
        go(nav.next)
        return true
      case 'p':
        go(nav.prev)
        return true
      case 'Home':
      case '0':
        seek(0)
        return true
      case 'Escape':
        if (!selected) return false
        select(undefined)
        return true
    }
    if (/^[1-9]$/.test(key) && el?.duration) {
      seek((el.duration * Number(key)) / 10)
      return true
    }
    return false
  })

  return (
    <div className="player" ref={root}>
      <div className="player-stage" onClick={toggle} onDoubleClick={fullscreen}>
        {src ? (
          <video
            key={view.id}
            ref={ref}
            className="player-video"
            src={host.url(String(src.data.path), src.seq)}
            autoPlay={autoplay && active}
            onPlay={() => {
              setPlaying(true)
              setEnded(false)
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setEnded(true)}
          />
        ) : (
          <div className="player-status">
            {error ? `无法播放：${error}` : `正在转换格式… ${progress !== undefined ? Math.round(progress * 100) + '%' : ''}`}
          </div>
        )}
        {ended && nav.next && <NextUp id={nav.next} host={host} go={go} />}
      </div>
      <ControlBar
        video={ref}
        view={view}
        host={host}
        playing={playing}
        nav={nav}
        go={go}
        toggle={toggle}
        seek={seek}
        volume={volume}
        muted={muted}
        rate={rate}
        setVolume={(v) => {
          setVolume(v)
          setMuted(false)
        }}
        setMuted={setMuted}
        setRate={setRate}
        fullscreen={fullscreen}
        play={play}
        pause={pause}
        reveal={reveal}
        selected={selected}
        select={select}
        revealId={revealId}
        overlayKeys={overlayRegister}
      />
    </div>
  )
}

/** 看完了：提示下一个。 */
function NextUp({ id, host, go }: { id: string; host: UiHost; go(id: string): void }) {
  const next = useEntity(id)
  return (
    <div className="player-next" onClick={(e) => e.stopPropagation()}>
      <span className="muted">下一个</span>
      <button className="small" onClick={() => go(id)}>
        {next ? host.title(next) : '…'}（N）
      </button>
    </div>
  )
}

interface ControlBarProps {
  video: RefObject<HTMLVideoElement | null>
  view: EntityView
  host: UiHost
  playing: boolean
  nav: Nav
  go(id: string | undefined): void
  toggle(): void
  seek(t: number): void
  volume: number
  muted: boolean
  rate: number
  setVolume(v: number): void
  setMuted(m: boolean): void
  setRate(r: number): void
  fullscreen(): void
  play(): void
  pause(): void
  reveal(t: number): void
  selected?: string
  select(id: string | undefined): void
  revealId?: string
  overlayKeys(id: string): (h: KeyHandler | null) => void
}

/** 控制条：时间每帧都在变，只让这一块跟着重绘。 */
const ControlBar = memo(function ControlBar(p: ControlBarProps) {
  const time = useClock(p.video, p.playing)
  const duration = p.video.current?.duration || Number(p.view.blocks.video.data.duration) || 0
  // 点完控件把焦点还给页面：否则空格、方向键会被滑块、下拉框吃掉
  const release = (e: React.SyntheticEvent) => (e.currentTarget as HTMLElement).blur()
  const overlays = p.host.overlays('timeline')

  return (
    <div className="player-bar">
      {overlays.length > 0 && (
        <div className="timeline-lane">
          {overlays.map((o) => (
            <o.Component
              key={o.id}
              target={p.view}
              host={p.host}
              duration={duration}
              time={time}
              playing={p.playing}
              seek={p.seek}
              play={p.play}
              pause={p.pause}
              reveal={p.reveal}
              selected={p.selected}
              select={p.select}
              revealId={p.revealId}
              registerKeys={p.overlayKeys(o.id)}
            />
          ))}
        </div>
      )}
      <Timeline time={time} duration={duration} view={p.view} host={p.host} seek={p.seek} />
      <div className="player-controls">
        <IconButton title="上一个（P）" disabled={!p.nav.prev} onClick={() => p.go(p.nav.prev)} d={ICONS.prev} />
        <IconButton title={p.playing ? '暂停（空格）' : '播放（空格）'} onClick={p.toggle} d={p.playing ? ICONS.pause : ICONS.play} />
        <IconButton title="下一个（N）" disabled={!p.nav.next} onClick={() => p.go(p.nav.next)} d={ICONS.next} />
        <span className="player-time">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
        <span className="player-title">
          {p.host.title(p.view)}
          {p.nav.total > 1 && p.nav.index >= 0 && (
            <span className="muted">
              {'  '}
              {p.nav.index + 1} / {p.nav.total}
            </span>
          )}
        </span>
        <select
          className="select"
          title="倍速"
          value={p.rate}
          onChange={(e) => {
            p.setRate(Number(e.target.value))
            release(e)
          }}
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
        <IconButton title="静音（M）" onClick={() => p.setMuted(!p.muted)} d={p.muted || p.volume === 0 ? ICONS.muted : ICONS.volume} />
        <input
          className="player-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={p.muted ? 0 : p.volume}
          title="音量（↑↓）"
          onChange={(e) => p.setVolume(Number(e.target.value))}
          onPointerUp={release}
        />
        <IconButton title="全屏（F）" onClick={p.fullscreen} d={ICONS.fullscreen} />
      </div>
    </div>
  )
})

/** 当前播放时间：播放时每帧取一次，暂停时跟着跳转事件更新。 */
function useClock(video: RefObject<HTMLVideoElement | null>, playing: boolean): number {
  const [time, setTime] = useState(0)
  useUiEffect(display => {
    const el = video.current
    if (!el) return
    const update = () => setTime(el.currentTime)
    update()
    display.on(el, 'seeked', update)
    display.on(el, 'timeupdate', update)
    display.on(el, 'loadedmetadata', update)
    const loop = () => { update(); display.frame(loop) }
    if (playing) display.frame(loop)
  }, [video, playing, video.current])
  return time
}

/** 时间轴：点击、拖动跳转；悬停时用预览帧块显示那一刻的画面。 */
function Timeline({ time, duration, view, host, seek }: { time: number; duration: number; view: EntityView; host: UiHost; seek(t: number): void }) {
  const [hover, setHover] = useState<number>()
  const bar = useRef<HTMLDivElement>(null)
  const ratioAt = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const frames = view.blocks.frames
  const played = duration ? Math.min(1, time / duration) : 0

  return (
    <div
      className="timeline"
      ref={bar}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        seek(ratioAt(e) * duration)
      }}
      onPointerMove={(e) => {
        const r = ratioAt(e)
        setHover(r)
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(r * duration)
      }}
      onPointerLeave={() => setHover(undefined)}
    >
      <div className="timeline-track">
        <div className="timeline-played" style={{ width: `${played * 100}%` }} />
      </div>
      <div className="timeline-knob" style={{ left: `${played * 100}%` }} />
      {hover !== undefined && (
        <div className="timeline-hover" style={{ left: `clamp(${HOVER_FRAME_WIDTH / 2}px, ${hover * 100}%, calc(100% - ${HOVER_FRAME_WIDTH / 2}px))` }}>
          {frames && <HoverFrame frames={frames} host={host} ratio={hover} />}
          <span>{formatDuration(hover * duration)}</span>
        </div>
      )}
    </div>
  )
}

/** 预览帧块是一张横向拼起来的长图，取第 i 格。 */
function HoverFrame({ frames, host, ratio }: { frames: NonNullable<EntityView['blocks'][string]>; host: UiHost; ratio: number }) {
  const count = Number(frames.data.count) || 1
  const tw = Number(frames.data.tileWidth) || 1
  const th = Number(frames.data.tileHeight) || 1
  const scale = HOVER_FRAME_WIDTH / tw
  const i = Math.min(count - 1, Math.floor(ratio * count))
  return (
    <div
      className="timeline-frame"
      style={{
        width: HOVER_FRAME_WIDTH,
        height: Math.round(th * scale),
        backgroundImage: `url("${host.url(String(frames.data.path), frames.seq)}")`,
        backgroundSize: `${count * HOVER_FRAME_WIDTH}px ${Math.round(th * scale)}px`,
        backgroundPosition: `-${i * HOVER_FRAME_WIDTH}px 0`
      }}
    />
  )
}

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  prev: 'M6 6h2v12H6zM9.5 12 18 18V6z',
  next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
  volume: 'M4 9v6h4l5 5V4L8 9H4zM16.5 12A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z',
  muted: 'M4 9v6h4l5 5V4L8 9H4zM15.6 9.4l1.4-1.4 2 2 2-2 1.4 1.4-2 2 2 2-1.4 1.4-2-2-2 2-1.4-1.4 2-2z',
  fullscreen: 'M4 4h6v2H6v4H4zM20 4v6h-2V6h-4V4zM4 20v-6h2v4h4v2zM20 20h-6v-2h4v-4h2z'
}

function IconButton({ d, title, onClick, disabled }: { d: string; title: string; onClick(): void; disabled?: boolean }) {
  return (
    <button
      className="player-btn"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        onClick()
        e.currentTarget.blur()
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <path d={d} />
      </svg>
    </button>
  )
}

function PlayerTitle({ params, host }: { params: PlayerParams; host: UiHost }) {
  const view = useEntity(params.id)
  return <>{view ? host.title(view) : '视频'}</>
}

export const playerTabType: TabType<PlayerParams, PlayerState> = {
  id: 'video.player',
  Title: PlayerTitle,
  Component: Player,
  // 同一个视频只开一个播放器
  key: (params) => params.id
}
