import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { LyricCandidate, LyricMatches } from './lyric-match'

interface MatchState { id?: string; result?: LyricMatches; loading: boolean; error?: string }
const Context = createContext<{ state: MatchState; refresh(): void; choose(candidate: LyricCandidate): Promise<void> } | null>(null)
export const useLyricMatching = () => { const value = useContext(Context); if (!value) throw new Error('歌词匹配会话未挂载'); return value }

/** 查找跟随播放会话，侧栏隐藏仍可工作；只读查询不进历史，采用通过核心事务复查。 */
export function LyricMatchingProvider({ host, id, playing, children }: {
  host: UiHost; id?: string; playing: boolean; children: ReactNode
}) {
  const [state, setState] = useState<MatchState>({ loading: false }), [revision, refresh] = useState(0)
  const started = useRef(new Set<string>()), protectedIds = useRef(new Set<string>())
  // 同一窗口中，自动采用或观察到已有歌词之后，不因撤销／移除而立刻填回来。
  const applying = useRef(new Set<string>())
  useEffect(() => {
    if (!id) { setState({ loading: false }); return }
    if (playing) started.current.add(id)
    let alive = true, running = false, dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      if (running) { dirty = true; return }
      running = true
      setState(previous => ({ ...(previous.id === id ? previous : {}), id, loading: previous.id !== id || !previous.result, error: undefined }))
      try {
        const result = await host.core.run('music', 'findLyrics', { id }) as LyricMatches
        if (!alive) return
        setState({ id, result, loading: false })
        if (result.existing) protectedIds.current.add(id)
        const candidate = result.candidates[0]
        if (started.current.has(id) && !protectedIds.current.has(id) && !applying.current.has(id) &&
          !result.existing && !result.pending && result.candidates.length === 1 && candidate.strong) {
          applying.current.add(id)
          try {
            await host.core.run('music', 'applyMatchedLyrics', { id, target: result.target, candidate: candidate.id, token: candidate.token, automatic: true })
            protectedIds.current.add(id)
            if (alive) host.notify(`已匹配仓库歌词：${candidate.label}；可以撤销`)
          } finally { applying.current.delete(id) }
        }
      } catch (e) { if (alive) setState(previous => ({ ...previous, id, loading: false, error: String(e) })) }
      finally {
        running = false
        if (alive && dirty) { dirty = false; schedule() }
      }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void run(), 180) }
    schedule()
    const off = host.core.on('listChanged', schedule)
    return () => { alive = false; clearTimeout(timer); off() }
  }, [host, id, playing, revision])
  const choose = async (candidate: LyricCandidate) => {
    const result = state.id === id ? state.result : undefined
    if (!id || !result || applying.current.has(id)) return
    applying.current.add(id)
    try {
      await host.core.run('music', 'applyMatchedLyrics', { id, target: result.target, candidate: candidate.id, token: candidate.token })
      protectedIds.current.add(id)
      host.notify('已采用仓库歌词，可以撤销')
    } finally { applying.current.delete(id); refresh(v => v + 1) }
  }
  return <Context.Provider value={{ state: state.id === id ? state : { id, loading: !!id }, refresh: () => refresh(v => v + 1), choose }}>{children}</Context.Provider>
}

export function LyricCandidates({ host }: { host: UiHost }) {
  const { state, refresh, choose } = useLyricMatching()
  const [busy, setBusy] = useState<string>(), [error, setError] = useState('')
  const currentId = useRef(state.id)
  currentId.current = state.id
  useEffect(() => { setBusy(undefined); setError('') }, [state.id])
  const result = state.result
  if (!state.id) return <p className="music-plain">选择一首歌曲，播放时会自动查找仓库歌词。</p>
  if (result?.existing) return <p className="music-plain">这首歌已有歌词记录，自动匹配不会覆盖。可通过下方按钮编辑。</p>
  return <div className="music-lyric-matches" aria-label="仓库歌词匹配">
    <div className="music-match-heading"><strong>{result?.candidates.length ? `找到 ${result.candidates.length} 份候选歌词` : '仓库歌词'}</strong>
      <button className="small" disabled={state.loading || !!busy} onClick={refresh}>重新匹配</button></div>
    {state.loading && <p role="status">正在查找…</p>}
    {!!result?.pending && <p role="status">{result.pending} 份文件正在建立索引，完成后会重新匹配。</p>}
    {!!result?.failed && <p>{result.failed} 份文件未能读取，可在文件的歌词索引中查看原因。</p>}
    {!state.loading && !result?.pending && !result?.candidates.length && !state.error && <p>没有找到匹配的歌词。把 LRC 文件收进仓库，或使用下方“添加歌词”。</p>}
    {!!result?.candidates.length && <p>请选择与这首歌对应的版本。只有唯一明确的匹配会在播放时自动采用。</p>}
    {result?.candidates.map(candidate => <article className="music-lyric-candidate" key={candidate.id} data-candidate-id={candidate.id}>
      <strong>{candidate.title}</strong><span>{candidate.artist || '歌手未标注'}{candidate.album ? ` · ${candidate.album}` : ''}</span>
      <small>{candidate.synced ? '同步歌词' : '普通歌词'} · {candidate.reason}</small>
      <pre>{candidate.preview || '（间奏）'}</pre>
      <div className="music-candidate-source"><button title={candidate.label} onClick={() => host.openData(candidate.id)}>{candidate.label}</button></div>
      <button className="music-primary" disabled={!!busy} onClick={async () => {
        const id = state.id
        setBusy(candidate.id); setError('')
        try { await choose(candidate) } catch (e) { if (currentId.current === id) setError(String(e)) }
        finally { if (currentId.current === id) setBusy(undefined) }
      }}>{busy === candidate.id ? '正在采用…' : '采用这份歌词'}</button>
    </article>)}
    {(error || state.error) && <p role="alert" className="music-error">{error || state.error}</p>}
  </div>
}
