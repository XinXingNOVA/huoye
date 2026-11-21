import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import { useEntityState } from '@resource-manager/plugin-api/ui/data'
import { usePlaybackRecord } from '@resource-manager/plugin-api/ui/playback'
import { MusicSession } from './session'
import { LyricMatchingProvider } from './lyric-matching'

const uiText = packageMessages('music')


const Context = createContext<MusicSession | null>(null)
export const useMusic = () => { const value = useContext(Context); if (!value) throw new Error(uiText("音乐窗口会话未挂载")); return value }
export const useSession = () => { const s = useMusic(); return useSyncExternalStore(s.subscribe, s.getSnapshot) }
const noClockSubscription = () => () => {}
export const useClock = (active = true) => { const s = useMusic(); return useSyncExternalStore(active ? s.subscribeClock : noClockSubscription, s.getClock) }

export function MusicProvider({ host, children }: { host: UiHost; children: ReactNode }) {
  useUiLocale()
  const [session] = useState(() => {
    const key = `music.session.v1:${host.root}`
    let saved: unknown
    try { saved = JSON.parse(localStorage.getItem(key) ?? 'null') } catch { /* 坏状态回到空队列 */ }
    let reported = false
    return new MusicSession(saved, value => {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { if (!reported) { reported = true; host.notify(uiText("播放状态无法保存到本机")) } }
    })
  })
  useEffect(() => {
    const unload = () => session.dispose()
    window.addEventListener('beforeunload', unload)
    return () => { window.removeEventListener('beforeunload', unload); session.dispose() }
  }, [session])
  return <Context.Provider value={session}><Matching host={host}><Engine host={host}/>{children}</Matching></Context.Provider>
}
function Matching({ host, children }: { host: UiHost; children: ReactNode }) {
  const state = useSession()
  return <LyricMatchingProvider host={host} id={state.queue[state.index]} playing={state.playing}>{children}</LyricMatchingProvider>
}
function Engine({ host }: { host: UiHost }) {
  const state = useSession()
  const id = state.queue[state.index]
  return id ? <Track key={`${id}:${state.generation}`} id={id} host={host} /> : null
}
function Track({ id, host }: { id: string; host: UiHost }) {
  useUiLocale()
  const state = useEntityState(id), session = useMusic()
  const view = state.view
  const usable = view && !view.deletedAt && view.blocks.audio && view.blocks.file
  useEffect(() => {
    if (state.status === 'missing' || (view && !usable)) session.fail(uiText("这首歌曲已移除或音频不可用；可以切到下一首"))
    if (state.status === 'error') session.fail(uiText("歌曲读取失败：{error}", { error: String(state.error) }))
  }, [state.status, view, usable, session])
  return usable ? <Audio view={view} host={host} /> : null
}
function Audio({ view, host }: { view: EntityView; host: UiHost }) {
  useUiLocale()
  const session = useMusic(), ref = useRef<HTMLAudioElement>(null)
  const proxy = view.blocks.audioProxy
  const source = proxy?.data.source === view.blocks.file.data.hash ? proxy : view.blocks.audio.data.playable ? view.blocks.file : undefined
  const path = source?.data.path as string | undefined
  usePlaybackRecord(ref, view.id, source?.seq, {
    position: Number(view.blocks.audioPlayback?.data.position ?? 0),
    save: sample => host.core.run('audio', 'recordPlayback', { id: view.id, hash: view.blocks.file?.data.hash, ...sample }),
    onError: () => host.notify(uiText("播放进度保存失败"))
  }, { restore: false })
  useEffect(() => {
    if (path) return
    let alive = true
    host.core.demand(view.id, 'audioProxy').then(ok => { if (alive && !ok) session.fail(uiText("音频转换不可用，请检查 ffmpeg 与音频插件")) })
      .catch(e => { if (alive) session.fail(String(e)) })
    return () => { alive = false }
  }, [path, host, view.id, session])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    session.element = el; el.volume = session.getSnapshot().volume
    const timer = setInterval(session.tick, 100)
    return () => { clearInterval(timer); if (session.element === el) { session.persist(); session.element = null } el.pause() }
  }, [path, session])
  return path ? <audio key={path} className="music-audio" ref={ref} src={host.url(path, source?.seq)} preload="metadata" aria-label={uiText("音乐播放引擎")}
    onLoadedMetadata={e => {
      const el = e.currentTarget
      el.currentTime = Math.min(session.resume, Math.max(0, el.duration - 0.1))
      session.tick()
      if (session.autoplay) session.play()
    }}
    onPlay={() => session.played(true)} onPause={e => { if (session.element === e.currentTarget) session.played(false) }}
    onEnded={() => session.next(false)} onError={() => session.fail(uiText("无法解码此音频，请确认文件存在且格式受支持"))} /> : null
}

/** 查询按变更合并，旧响应不覆盖新的查询，卸载后停止订阅。 */
export function useIds(host: UiHost, kind: string, text = '') {
  const [state, setState] = useState<{ ids: string[]; error?: string; loading: boolean }>({ ids: [], loading: true })
  useEffect(() => {
    let alive = true, revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      const rev = ++revision
      host.core.query({ scope: kind === 'musicPlaylist' ? 'all' : 'content', has: [kind], text, dir: 'asc' })
        .then(r => { if (alive && rev === revision) setState({ ids: r.ids, loading: false }) })
        .catch(e => { if (alive && rev === revision) setState({ ids: [], loading: false, error: String(e) }) })
    }
    setState({ ids: [], loading: true }); run()
    const off = host.core.on('listChanged', () => { clearTimeout(timer); timer = setTimeout(run, 120) })
    return () => { alive = false; off(); clearTimeout(timer) }
  }, [host, kind, text])
  return state
}
export function trackInfo(view: EntityView | undefined, host: UiHost) {
  const base = view?.blocks.audio?.data ?? {}, edited = view?.blocks.musicTrack?.data ?? {}
  return { title: String(edited.title || base.title || (view ? host.title(view) : uiText("歌曲不可用"))),
    artist: String(edited.artist || base.artist || uiText("未知艺术家")), album: String(edited.album || base.album || ''), duration: Number(base.duration ?? 0) }
}
