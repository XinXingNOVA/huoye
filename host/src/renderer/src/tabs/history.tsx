import { libraryPageWorkbench } from '../page-workbench'
import { useEffect, useState } from 'react'
import type { HistoryDetail, HistoryPage } from '../../../shared/history'
import type { TabProps, TabType } from '../plugin'
import './history.css'

const states = { done: '已完成', undone: '已撤销', discarded: '已放弃重做' }
const sources = { application: '应用', external: '外部调用', system: '自动处理' }

function HistoryTab({ host, visible, setFocus }: TabProps) {
  const [page, setPage] = useState<HistoryPage>()
  const [before, setBefore] = useState<number[]>([])
  const [selected, setSelected] = useState<number>()
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<HistoryDetail>()
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [generation, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const core = host.core
  useEffect(() => { setFocus([]) }, [setFocus])
  useEffect(() => {
    if (!visible) return
    const reload = () => { setBefore([]); refresh(n => n + 1) }
    reload()
    return core.on('historyChanged', reload)
  }, [visible, core])
  const cursor = before.at(-1)
  useEffect(() => {
    if (!visible) return
    let alive = true
    setLoading(true)
    void core.listHistory({ before: cursor }).then(result => {
      if (!alive) return
      setPage(result); setError(''); setLoading(false)
    }, e => { if (alive) { setError(String(e)); setLoading(false) } })
    return () => { alive = false }
  }, [visible, core, cursor, generation])
  useEffect(() => {
    if (!visible || selected === undefined) { setDetail(undefined); return }
    let alive = true
    setDetail(undefined); setDetailError('')
    void (async () => {
      const result = await core.readHistory({ id: selected, offset })
      const views = await core.get(result.entities.filter(e => e.exists).map(e => e.id))
      if (alive) { setDetail(result); setTitles(Object.fromEntries(views.map(v => [v.id, host.title(v)]))) }
    })().catch(e => { if (alive) setDetailError(String(e)) })
    return () => { alive = false }
  }, [visible, core, host, selected, offset, generation])
  const replay = async (direction: 'undo' | 'redo') => {
    const target = page?.[direction]
    if (!page || !target || busy || loading) return
    setBusy(true); setError('')
    try {
      const label = await core[direction]({ session: page.session, revision: page.revision, id: target.id })
      if (label) host.notify(`${direction === 'undo' ? '已撤销' : '已重做'}：${label}`)
    } catch (e) { host.notify(String(e)); setError(String(e)); refresh(n => n + 1) }
    finally { setBusy(false) }
  }
  return <div className="operation-history">
    <header><h1>操作历史</h1><p className="muted">本次打开仓库后的数据修改，按顺序撤销或重做。</p></header>
    <div className="history-actions">
      <button className="small" onClick={() => host.openTab('batch-review', {})}>批次验收单</button>
      <button className="small" disabled={!page?.undo || loading || busy} title={page?.undo?.label} onClick={() => void replay('undo')}>撤销上一步</button>
      <button className="small" disabled={!page?.redo || loading || busy} title={page?.redo?.label} onClick={() => void replay('redo')}>重做下一步</button>
      <span className="muted">{page?.undo ? `下一步撤销：${page.undo.label}` : '没有可撤销的操作'}</span>
    </div>
    {error && <p role="alert" className="history-error">{error}</p>}
    <div className="history-body">
      <section aria-label="操作记录" className="history-list" aria-busy={loading}>
        {!page && loading && <p>读取操作历史…</p>}
        {page?.entries.length === 0 && <p className="muted">本次会话还没有操作记录。</p>}
        {page?.entries.map(entry => <button key={entry.id} className={`history-row ${selected === entry.id ? 'selected' : ''}`} aria-pressed={selected === entry.id} onClick={() => { setSelected(entry.id); setOffset(0) }}>
          <span className="history-row-top"><strong>{entry.label}</strong><span className={`history-state ${entry.state}`}>{states[entry.state]}</span></span>
          <span className="history-row-meta"><time>{new Date(entry.at).toLocaleTimeString()}</time><span>{sources[entry.source]}</span><span>{entry.affected} 项</span></span>
        </button>)}
        {!!page?.total && <nav className="history-paging" aria-label="历史翻页">
          <button className="small" disabled={!before.length || loading} onClick={() => setBefore(path => path.slice(0, -1))}>上一页</button>
          <span>共 {page.total} 条</span>
          <button className="small" disabled={!page.nextBefore || loading} onClick={() => { if (page.nextBefore) setBefore(path => [...path, page.nextBefore!]) }}>下一页</button>
        </nav>}
      </section>
      <aside className="history-detail" aria-label="操作详情">
        {selected === undefined ? <p className="muted">选择一条记录查看影响范围。</p> : detailError ? <p role="alert" className="history-error">{detailError}</p> : !detail ? <p className="muted">读取详情…</p> : <>
          <h2>{detail.entry.label}</h2>
          <p className="muted">{new Date(detail.entry.at).toLocaleString()} · {sources[detail.entry.source]} · {states[detail.entry.state]}</p>
          {detail.entry.operation && <p>操作：<code>{detail.entry.operation}</code>{detail.entry.plugin && <> · {detail.entry.plugin}</>}</p>}
          {detail.entry.requestId && <p>请求 ID：<code>{detail.entry.requestId}</code></p>}
          <h3>影响的记录（{detail.entry.affected}）</h3>
          {detail.entities.map(entity => <div key={entity.id} className="history-entity">
            <button className="small" disabled={!entity.exists} onClick={() => host.openData(entity.id)}>{titles[entity.id] || entity.id}</button>
            <small className="muted">{entity.kinds.join('、') || '身份状态'}{entity.kindsTruncated ? '…' : ''}{!entity.exists ? ' · 当前不存在' : entity.trashed ? ' · 回收站' : ''}</small>
          </div>)}
          {(offset > 0 || detail.nextOffset !== null) && <nav className="history-paging" aria-label="影响记录翻页">
            <button className="small" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button>
            <button className="small" disabled={detail.nextOffset === null} onClick={() => setOffset(detail.nextOffset!)}>下一页</button>
          </nav>}
        </>}
      </aside>
    </div>
    <footer className="muted">{!!page?.retention?.trimmed && <>较早的 {page.retention.trimmed} 笔历史已按保留上限清理。 </>}仅显示仓库撤销记录。重开或重载仓库会清理旧会话；永久清除素材会清理其历史。文件空间、系统废纸篓及尚未保存的草稿使用各自的恢复机制。</footer>
  </div>
}

export const historyTabType: TabType = { id: 'history', workbench: { ...libraryPageWorkbench, describe: () => ({ title: '操作历史' }) }, Title: () => <>操作历史</>, Component: HistoryTab, key: () => 'history', instances: { scope: 'type', max: 1 } }
