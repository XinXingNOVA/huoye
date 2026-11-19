import { useState } from 'react'
import type { UiHost } from '../plugin'
import { useEntity } from '../entity-cache'
import { rejectionReasons, rejectionState, type AdmissionReport } from '../admission-report'
import { QueryDialog } from './QueryBuilder'
import { importSummary } from '../import-policy'

interface Props { reports: AdmissionReport[]; host: UiHost; dismiss(id: string): void }
const PAGE_SIZE = 20

/** 批次结果保留到主动关闭；新的异步结果不能覆盖用户正在查看的一批。 */
export function AdmissionFeedback({ reports, host, dismiss }: Props) {
  const [selected, setSelected] = useState<string>(), [details, setDetails] = useState(false)
  const report = reports.find(r => r.id === selected) ?? reports[0]
  if (!report) return null
  const index = reports.indexOf(report)
  const close = () => { setDetails(false); dismiss(report.id) }
  const open = (ids: string[], title: string) => {
    host.openTab('collection', { title, query: { scope: 'content', ids }, layout: 'masonry' })
    setDetails(false)
  }
  const status = report.failure ? '检查未完成' : '未匹配'
  const summary = [report.failure ? '本批处理未完成' : `已进入 ${report.accepted.length} 项`, report.uncollected.length ? `未收录 ${report.uncollected.length} 项` : '', report.rejected.length ? `${status} ${report.rejected.length} 项` : '', report.imports?.errors.length ? `导入未完成 ${report.imports.errors.length} 项` : ''].filter(Boolean).join(' · ')
  return <>
    <section className="admission-feedback" aria-label="视图处理结果" onKeyDown={e => e.stopPropagation()}>
      <header><strong title={report.title}>放入「{report.title}」</strong><button aria-label="关闭这批结果" onClick={close}>×</button></header>
      <div role="status"><p>{summary}</p>
        {!!report.rejected.length && <p className="admission-state">{rejectionState(report)}，未应用这次视图整理。</p>}
        {!!report.uncollected.length && <p className="admission-state">未选择的输入保持原处，没有写入仓库或文件空间。</p>}
        {!report.rejected.length && report.imports && <p className="admission-state">{report.imports.errors.length ? `另有 ${report.imports.errors.length} 项导入未完成。` : '文件已按导入配置处理，请查看详情。'}</p>}
      </div>
      <div className="admission-actions"><button className="primary" onClick={() => setDetails(true)}>查看结果与原因</button>
        {!!report.rejected.length && <button onClick={() => open(report.rejected.map(r => r.id), `${status} · ${report.title}`)}>查看素材</button>}
        {reports.length > 1 && <span className="admission-batches"><button aria-label="上一批结果" disabled={!index} onClick={() => setSelected(reports[index - 1].id)}>‹</button>{index + 1} / {reports.length} 批<button aria-label="下一批结果" disabled={index === reports.length - 1} onClick={() => setSelected(reports[index + 1].id)}>›</button></span>}
      </div>
    </section>
    {details && <QueryDialog title={`处理结果 · ${report.title}`} onClose={() => setDetails(false)}>
      <ReportDetails key={report.id} report={report} host={host} summary={summary} onInspect={() => setDetails(false)} />
      <footer className="admission-footer"><span className="muted">关闭提示不会撤销导入或删除原文件。</span>
        {!!report.rejected.length && <button onClick={() => open(report.rejected.map(r => r.id), `${status} · ${report.title}`)}>查看未进入的素材</button>}
        {!!report.accepted.length && <button onClick={() => open(report.accepted, `已匹配 · ${report.title}`)}>查看已进入的素材</button>}
        <button className="primary" onClick={close}>完成</button>
      </footer>
    </QueryDialog>}
  </>
}

function ReportDetails({ report, host, summary, onInspect }: { report: AdmissionReport; host: UiHost; summary: string; onInspect(): void }) {
  const [page, setPage] = useState(0), pages = Math.ceil(report.rejected.length / PAGE_SIZE)
  const [inputPage, setInputPage] = useState(0), inputPages = Math.ceil(report.uncollected.length / PAGE_SIZE)
  const reasons = rejectionReasons(report)
  return <div className="admission-details">
    <p className="admission-summary">{summary}</p>
    {!!report.uncollected.length && <><h3>未收录的输入</h3><p className="muted">这些输入未被选择，原文件没有改动。</p><ul className="admission-items">{report.uncollected.slice(inputPage * PAGE_SIZE, (inputPage + 1) * PAGE_SIZE).map((row, i) => <li key={i}><strong>{row.title}</strong><p>{row.reason ?? '本次未选择收录'}</p></li>)}</ul>
      {inputPages > 1 && <div className="admission-pages"><button disabled={!inputPage} onClick={() => setInputPage(inputPage - 1)}>上一页</button><span>{inputPage + 1} / {inputPages}</span><button disabled={inputPage + 1 >= inputPages} onClick={() => setInputPage(inputPage + 1)}>下一页</button></div>}</>}
    {!!report.rejected.length && <p>{rejectionState(report)}。这些项未应用这次视图整理。</p>}
    {report.failure ? <p className="admission-error" role="alert">导入或整理未完成：{report.failure}</p> : !!reasons.length && <>
      <h3>未满足的条件</h3><ul className="admission-reasons">{reasons.map(r => <li key={r.reason}><span>{r.reason}</span><strong>{r.count} 项</strong></li>)}</ul>
      <p className="muted">每项列出首先发现的原因；一项内容可能不满足多个条件。</p>
    </>}
    {!!report.failedInputs?.length && <details open className="admission-imports"><summary>本批未完成收录的输入：{report.failedInputs.length} 项</summary><p className="admission-failed-inputs">{report.failedInputs.join('、')}</p></details>}
    {!!report.rejected.length && <>
      <h3>{report.failure ? '检查未完成的素材' : '未匹配的素材'}</h3>
      <ul className="admission-items">{report.rejected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => <RejectedItem key={row.id} row={row} host={host} failure={!!report.failure} onInspect={onInspect} />)}</ul>
      {pages > 1 && <div className="admission-pages"><button disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>}
    </>}
    {report.imports && <details className="admission-imports" open={!!report.imports.errors.length || !report.imports.items.length}><summary>文件导入结果</summary><p>{importSummary(report.imports)}</p></details>}
    <p className="muted">视图结果按素材身份去重统计。这里记录本次处理结果；后续修改数据或规则可能改变当前归属。</p>
  </div>
}

function RejectedItem({ row, host, failure, onInspect }: { row: AdmissionReport['rejected'][number]; host: UiHost; failure: boolean; onInspect(): void }) {
  const view = useEntity(row.id)
  const title = String(view?.blocks.file?.data.name ?? (view ? host.title(view) : row.id))
  return <li><div><strong title={title}>{title}</strong><small>{row.origin === 'created' ? '已新增到仓库' : row.origin === 'restored' ? '已恢复到仓库' : '库内原有素材'}</small></div>
    <p>{failure ? row.reason : `未满足：${row.reason}`}</p>
    <button className="small" onClick={() => { host.openData(row.id); onInspect() }}>查看详情</button>
  </li>
}
