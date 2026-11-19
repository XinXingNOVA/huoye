import { useEffect, useState } from 'react'
import { useEntity } from '../../../plugin-api/ui/data'
import type { ReviewChange, ReviewList, ReviewPage, ReviewSummary } from '../../../shared/batch-review'
import type { TabProps, TabType, UiHost } from '../plugin'
import { coverFor } from '../ui-registry'
import { GenericCover } from '../components/DataDetails'
import './batch-review.css'

const labels = { pending: '待验收', confirmed: '已确认', withdrawn: '已撤回' }
function decisionLabel(batch: ReviewSummary) {
  return batch.state === 'confirmed' && batch.withdrawnItems ? '剩余项已确认' : labels[batch.state]
}
const pageSize = 20
function valueText(value: unknown, change: ReviewChange): string {
  if (value === null) return '未填写'
  if (Array.isArray(value)) return value.map(v => valueText(v, change)).join('、')
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'string' && change.referenceTitles && Object.hasOwn(change.referenceTitles, value)) return change.referenceTitles[value]
  return change.format === 'rating' ? `${value} 星` : String(value)
}
function Change({ change: c }: { change: ReviewChange }) {
  return <li>
    {c.member ? <><span>{c.title} · {c.after ? '添加' : '移除'}</span><strong>{valueText(c.member, c)}</strong></>
      : !c.field ? <><span>{c.after ? '加入数据块' : '移除数据块'}</span><strong>{c.title}</strong></>
      : <><span>{c.title}</span><del>{valueText(c.before, c)}</del><span aria-label="改为">→</span><ins>{valueText(c.after, c)}</ins></>}
    {c.preserved && <small>{c.member || !c.field ? (c.currentPreview ? '保留现有' : '保持移除') : `保留现值 · ${valueText(c.currentPreview, c)}`}</small>}
  </li>
}
function ReviewCard({ item, host, select, withdraw, busy }: { busy: boolean; withdraw?: () => void; item: ReviewPage['items'][number]; host: UiHost; select(): void }) {
  const view = useEntity(item.id), cover = view && coverFor(view)
  return <article data-review-item={item.id}>
    <button className="review-material" onClick={select} title="在检查器中查看或修改素材">
      <span className="review-cover">{view && (cover ? <cover.Component view={view} host={host} /> : <GenericCover view={view} host={host} />)}</span>
      <strong>{view ? host.title(view) : item.id}</strong>
    </button>
    <ul>{item.changes.map(c => <Change key={JSON.stringify([c.kind,c.field,c.member])} change={c} />)}</ul>
    <div className="review-actions"><button className="small" onClick={() => host.openData(item.id)}>打开素材详情</button>
      {item.withdrawn ? <span>已撤回</span> : withdraw && <button className="small" disabled={busy} onClick={withdraw}>撤回此项</button>}</div>
  </article>
}
function ReviewTab({ params, host, visible, setFocus }: TabProps) {
  const id = typeof params.batchId === 'string' ? params.batchId : undefined
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<ReviewList | ReviewPage>()
  const [generation, refresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const core = host.core
  useEffect(() => { setOffset(0); setResult(undefined); setFocus([]) }, [id, setFocus])
  useEffect(() => {
    if (!visible) return
    const update = () => refresh(n => n + 1)
    const off = [core.on('reviewsChanged', update), core.on('historyChanged', update), core.on('kinds', update)]
    return () => off.forEach(stop => stop())
  }, [visible, core])
  useEffect(() => {
    if (!visible) return
    let alive = true
    void core.reviewBatch(id ? { action: 'get', batchId: id, offset, limit: pageSize } : { action: 'list', offset, limit: pageSize })
      .then(r => { if (alive) { setResult(r); setError('') } },
        e => { if (alive) { setResult(undefined); setError(String(e)) } })
    return () => { alive = false }
  }, [visible, core, id, offset, generation])
  const page = result && 'batch' in result && result.batch.id === id ? result : undefined
  const list = result && 'batches' in result ? result : undefined
  const decide = async (action: 'confirm' | 'withdraw', entity?: string) => {
    if (!page || busy) return
    setBusy(true)
    try { await core.reviewBatch(action === 'withdraw' && entity ? { action, batchId: page.batch.id, ids: [entity] } : { action, batchId: page.batch.id }); refresh(n => n + 1) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const open = (b: ReviewSummary) => host.openTab('batch-review', { batchId: b.id, title: b.title })
  return <section className="batch-review" aria-label="批次验收">
    <header><div>{id && <button className="small" onClick={() => host.openTab('batch-review', {})}>全部验收单</button>}
      <h1>{page?.batch.title ?? (id ? '批次验收' : '批次验收单')}</h1>
      {page && <p role="status">{decisionLabel(page.batch)} · {page.batch.items} 项素材 · {page.batch.changes} 处改动
        {page.batch.unchangedRequests.length > 0 && ` · ${page.batch.unchangedRequests.length} 笔请求未改变数据`}
        {page.batch.withdrawnItems > 0 && ` · ${page.batch.withdrawnItems} 项已撤回`}
        {page.batch.decidedBy && ` · ${page.batch.decidedBy === 'application' ? '应用内操作' : '外部代办'}`}
        {page.batch.preserved > 0 && ` · ${page.batch.preserved} 处保留当前值`}</p>}</div>
      {page?.batch.state === 'pending' && <div className="review-actions"><button className="small" disabled={busy} onClick={() => void decide('confirm')}>{page.batch.withdrawnItems ? '确认剩余项' : '全部确认'}</button>
        <button className="small" disabled={busy} onClick={() => void decide('withdraw')}>{page.batch.withdrawnItems ? '撤回剩余项' : '整批撤回'}</button></div>}
    </header>
    {error && <p role="alert">{error}</p>}
    {!result && !error && <p>读取验收单…</p>}
    {list && <div className="review-index">{!list.batches.length && <p>还没有批次验收单。</p>}
      {list.batches.map(b => <button key={b.id} onClick={() => open(b)}><strong>{b.title}</strong><span>{decisionLabel(b)} · {b.items} 项 · {new Date(b.created).toLocaleString()}</span></button>)}</div>}
    {page && <div className="review-grid">{!page.items.length && <p>这些请求合并后没有净变化。</p>}
      {page.items.map(item => <ReviewCard key={item.id} item={item} host={host} busy={busy} withdraw={page.batch.state === 'pending' ? () => void decide('withdraw', item.id) : undefined} select={() => setFocus([item.id])} />)}</div>}
    {result && (offset > 0 || result.nextOffset !== null) && <nav aria-label="验收单翻页">
      <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - pageSize))}>上一页</button>
      <span aria-live="polite">第 {1 + Math.floor(offset / pageSize)} 页</span>
      <button disabled={result.nextOffset === null} onClick={() => setOffset(result.nextOffset!)}>下一页</button>
    </nav>}
  </section>
}
export const batchReviewTab: TabType = {
  id: 'batch-review', key: p => String(p.batchId ?? 'list'),
  Title: ({ params }) => <>{String(params.title ?? '批次验收单')}</>, Component: ReviewTab
}
