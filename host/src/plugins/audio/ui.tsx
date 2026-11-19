import { useEffect, useRef, useState } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { Query } from '../../shared/query'
import type { PreviewProps, TabProps, TabType, UiHost, UiPlugin, ViewProps } from '../../plugin-api/ui/contracts'
import { useEntity, useEntityState } from '../../plugin-api/ui/data'
import { useKeys } from '../../plugin-api/ui/hooks'
import { useNeighbors } from '../../plugin-api/ui/navigation'
import { formatDuration } from '../../plugin-api/ui/widgets'
import { ResourceCover } from '../../plugin-api/ui/media'
import { useAudioPlayback } from './playback'
import './style.css'

function sourceOf(view: EntityView, force: boolean) {
  const proxy = view.blocks.audioProxy
  if (proxy?.data.source === view.blocks.file?.data.hash) return proxy
  return !force && view.blocks.audio?.data.playable ? view.blocks.file : undefined
}

function AudioMark() {
  return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M24 45V18l28-6v27M24 27l28-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><ellipse cx="16" cy="46" rx="8" ry="6" fill="currentColor"/><ellipse cx="44" cy="40" rx="8" ry="6" fill="currentColor"/></svg>
}

function AudioCover({ view }: ViewProps) {
  return <div className="audio-cover"><AudioMark/><span>{String(view.blocks.audio.data.codec).toUpperCase()}</span></div>
}

/** 单独播放器和空格试听共用；换素材时调用方按 id 重建，保留旧元素供进度清理回调读取。 */
function AudioPlayer({ view, host, registerKeys, active = true, autoPlay = false }: PreviewProps & { active?: boolean; autoPlay?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [force, setForce] = useState(false)
  const [error, setError] = useState<string>()
  const [progress, setProgress] = useState<number>()
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const src = sourceOf(view, force)
  const needed = !src
  const audio = view.blocks.audio.data
  useAudioPlayback(ref, view, host, src?.seq)

  useEffect(() => {
    if (!needed || !active) return
    let alive = true
    const off = host.core.on('job', j => {
      if (j.id === view.id && j.system === 'audio.proxy') setProgress(j.progress)
    })
    void host.core.demand(view.id, 'audioProxy').then(ok => {
      if (alive && !ok) setError('转换功能暂不可用，请检查设置中的音频插件和 ffmpeg')
    }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false; off() }
  }, [host, view.id, needed, active])
  useEffect(() => { if (!active) ref.current?.pause() }, [active, src?.seq])
  useEffect(() => { if (ref.current) ref.current.playbackRate = rate }, [rate, src?.seq])

  const seek = (delta: number) => {
    const el = ref.current
    if (el && Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + delta))
  }
  useKeys(registerKeys, e => {
    if (e.metaKey || e.ctrlKey || e.altKey || !ref.current) return false
    if (e.key === ' ' || e.key.toLowerCase() === 'k') {
      const el = ref.current
      if (el.paused) void el.play().catch(() => host.notify('未能开始播放，请使用播放按钮重试'))
      else el.pause()
      return true
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      seek(e.key === 'ArrowLeft' ? -5 : 5)
      return true
    }
    return false
  })

  const failure = error ?? (needed ? view.failures['audio.proxy'] : undefined)
  return <div className="audio-player" onMouseDown={e => e.stopPropagation()}>
    <div className="audio-art">{view.blocks.thumb ? <ResourceCover view={view} host={host}/> : <AudioMark/>}</div>
    <div className="audio-heading">
      <h2>{host.title(view)}</h2>
      {audio.title && audio.title !== host.title(view) ? <p>{String(audio.title)}</p> : null}
      {(audio.artist || audio.album) ? <p>{[audio.artist, audio.album].filter(Boolean).join(' · ')}</p> : null}
      <p className="audio-facts">{formatDuration(Number(audio.duration))} · {String(audio.codec).toUpperCase()}{audio.sampleRate ? ` · ${Number(audio.sampleRate) / 1000} kHz` : ''}{audio.channels ? ` · ${audio.channels} 声道` : ''}</p>
    </div>
    {src ? <>
      <audio key={String(src.data.path)} ref={ref} controls preload="metadata" aria-label="音频播放"
        src={host.url(String(src.data.path), src.seq)} autoPlay={autoPlay && active} loop={loop}
        onRateChange={e => setRate(e.currentTarget.playbackRate)}
        onError={() => setError('当前文件无法直接播放')}/>
      <div className="audio-options">
        <button className="small" onClick={e => { seek(-5); e.currentTarget.blur() }} title="后退 5 秒（←）">−5 秒</button>
        <button className="small" onClick={e => { seek(5); e.currentTarget.blur() }} title="前进 5 秒（→）">+5 秒</button>
        <label>速度 <select aria-label="播放速度" value={rate} onChange={e => setRate(Number(e.target.value))}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => <option key={r} value={r}>{r}×</option>)}
        </select></label>
        <label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)}/> 循环</label>
      </div>
    </> : !failure ? <p role="status">正在准备播放副本…{progress === undefined ? '' : ` ${Math.round(progress * 100)}%`}</p> : null}
    {failure ? <div className="audio-error" role="alert">
      <p>{failure}</p>
      {src === view.blocks.file && src ? <button className="small" onClick={() => { setError(undefined); setForce(true) }}>转换后播放</button> :
        <p className="hint">可以从素材菜单重新加工，或在文件夹中打开原文件。</p>}
      <button className="small" onClick={() => host.reveal(host.abs(String(view.blocks.file.data.path)))}>显示原文件</button>
    </div> : null}
  </div>
}

function AudioPreview(props: PreviewProps) {
  return <AudioPlayer key={props.view.id} {...props} autoPlay/>
}

interface AudioParams extends Record<string, unknown> { id: string; list?: Query }
function AudioTab({ params, host, expose, active, saved, setState, setParams, setFocus, registerKeys }: TabProps<AudioParams, { opened: true }>) {
  const state = useEntityState(params.id)
  const contextTitle = state.view ? host.title(state.view) : '音频播放页'
  useEffect(() => expose({ context: { title: contextTitle } }), [expose, contextTitle])
  const neighbors = useNeighbors(host, params.list, params.id, 'audio')
  const autoPlay = useRef(!saved)
  useEffect(() => { setFocus([params.id]); setState({ opened: true }) }, [params.id, setFocus, setState])
  if (!state.view) return <div className="empty">{state.status === 'error' ? state.error : state.status === 'missing' ? '音频已不存在' : '正在读取…'}</div>
  if (state.view.deletedAt) return <div className="empty">音频已在回收站</div>
  if (!state.view.blocks.audio || !state.view.blocks.file) return <div className="empty">此素材没有可用的音频数据</div>
  const go = (id: string | undefined) => { if (id) { autoPlay.current = true; setParams({ ...params, id }) } }
  return <div className="audio-tab">
    <div className="audio-nav">
      <button className="small" disabled={!neighbors.prev} onClick={() => go(neighbors.prev)}>上一个</button>
      <span>{neighbors.index >= 0 ? `${neighbors.index + 1} / ${neighbors.total}` : '音频'}</span>
      <button className="small" disabled={!neighbors.next} onClick={() => go(neighbors.next)}>下一个</button>
    </div>
    <AudioPlayer key={params.id} view={state.view} host={host} active={active} autoPlay={autoPlay.current} registerKeys={registerKeys}/>
    <p className="audio-shortcuts">空格 播放 / 暂停 · ← → 前后 5 秒</p>
  </div>
}

function AudioTitle({ params, host }: { params: AudioParams; host: UiHost }) {
  const view = useEntity(params.id)
  return <>{view ? host.title(view) : '音频'}</>
}
const tabType: TabType<AudioParams, { opened: true }> = { id: 'audio.player', Title: AudioTitle, key: p => p.id, Component: AudioTab }

function AudioSection({ view, host }: ViewProps) {
  const a = view.blocks.audio.data
  const pb = view.blocks.audioPlayback?.data
  return <dl className="props">
    <dt>时长</dt><dd>{formatDuration(Number(a.duration))}</dd>
    <dt>编码</dt><dd>{String(a.codec)}</dd>
    {a.sampleRate ? <><dt>采样率</dt><dd>{Number(a.sampleRate) / 1000} kHz</dd></> : null}
    {a.channels ? <><dt>声道</dt><dd>{String(a.channels)}</dd></> : null}
    {a.bitRate ? <><dt>码率</dt><dd>{Math.round(Number(a.bitRate) / 1000)} kbps</dd></> : null}
    {(['title', 'artist', 'album'] as const).map((key, i) => a[key] ? <div className="audio-prop" key={key}><dt>{['曲名', '艺术家', '专辑'][i]}</dt><dd>{String(a[key])}</dd></div> : null)}
    <dt>播放</dt><dd>{view.blocks.audioProxy ? '使用播放副本' : a.playable ? '可直接播放' : '播放时转换格式'}</dd>
    {pb ? <><dt>进度</dt><dd>{pb.finished ? '已听完' : `上次听到 ${formatDuration(Number(pb.position))}`}</dd></> : null}
    <dt/><dd><button className="small" onClick={() => host.open(view.id)}>在播放器中打开</button></dd>
  </dl>
}

export const plugin: UiPlugin = {
  id: 'audio',
  views: [
    { id: 'audio.tracks', title: '音频', query: { has: ['audio'] }, defaultVisible: false, order: 22 },
    { id: 'audio.unfinished', title: '没听完的', query: { has: ['audio', 'audioPlayback'], where: [{ op: 'eq', kind: 'audioPlayback', field: 'finished', value: false }] }, defaultVisible: false, order: 23 }
  ],
  covers: [{ priority: 15, match: v => !!v.blocks.audio, Component: AudioCover }],
  previews: [{ priority: 10, match: v => !!v.blocks.audio && !!v.blocks.file, Component: AudioPreview }],
  opens: [{ id: 'audio.player', title: '音频试听', priority: 10, match: v => !!v.blocks.audio && !!v.blocks.file, tab: 'audio.player', params: (v, from) => ({ id: v.id, list: from }) }],
  tabTypes: [tabType],
  badges: [{ order: 50, get: v => v.blocks.audio ? { text: formatDuration(Number(v.blocks.audio.data.duration)) } : undefined }],
  sections: [{ id: 'audio', title: '音频', order: 21, kinds: ['audio', 'audioProxy', 'audioPlayback'], match: v => !!v.blocks.audio, Component: AudioSection }]
}
