import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useState } from 'react'
import type { ViewImportCandidate } from '../../../shared/view-import'
import { QueryDialog } from './QueryBuilder'

export interface ViewImportReviewRequest {
  id: string; title: string; candidates: ViewImportCandidate[]
  deferred?: boolean
  resolve(selected: number[] | null): void
}
/** 这里只选择输入；关闭／取消时没有发生导入。 */
export function ViewImportReview({ request, finish }: { request: ViewImportReviewRequest; finish(selected: number[] | null): void }) {
  useUiLocale()
  const { candidates } = request
  const matched = candidates.flatMap((row, i) => row.status === 'matched' ? [i] : [])
  const [selected, setSelected] = useState(() => new Set(matched)), [page, setPage] = useState(0)
  const forced = [...selected].filter(i => candidates[i].status !== 'matched').length
  const count = (status: ViewImportCandidate['status']) => candidates.filter(c => c.status === status).length
  const pages = Math.ceil(candidates.length / 20)
  const confirm = () => finish([...selected].sort((a, b) => a - b))
  return <QueryDialog title={uiText("收录前检查 · {title}", { title: String(request.title) })} onClose={() => finish(null)}>
    <div className="view-import-review">
      <p className="admission-summary">{uiText("初步匹配")}{' '}{matched.length}{' '}{uiText("项 · 未匹配")}{' '}{count('unmatched')}{' '}{uiText("项 · 待确认")}{' '}{count('unknown')}{' '}{uiText("项")}{count('error') ? uiText(" · 无法读取 {value1} 项", { value1: String(count('error')) }) : ''}</p>
      <p>{uiText("尚未收录。默认只选择初步匹配的内容；未选择的内容不会加入仓库或文件空间。")}</p>
      <p className="muted">{uiText("格式、大小等按输入文件预检；正文、图片尺寸等需要加工的条件会列为待确认。正式收录前仍会校验，预检不代替最终结果。")}</p>
      <div className="admission-actions"><button onClick={() => setSelected(new Set(matched))}>{uiText("仅选择匹配项")}</button><button onClick={() => setSelected(new Set())}>{uiText("清空选择")}</button></div>
      <ul className="view-import-candidates">{candidates.slice(page * 20, (page + 1) * 20).map((row, offset) => {
        const index = page * 20 + offset
        return <li key={index}><label><input type="checkbox" disabled={row.status === 'error'} checked={selected.has(index)} onChange={e => { const next = new Set(selected); if (e.target.checked) next.add(index); else next.delete(index); setSelected(next) }} /><span><strong title={row.title}>{row.title}</strong><small>{row.reason ?? uiText("初步匹配，提交时再次校验")}</small></span><em>{({ matched: uiText("匹配"), unmatched: uiText("未匹配"), unknown: uiText("待确认"), error: uiText("无法读取") })[row.status]}</em></label></li>
      })}</ul>
      {pages > 1 && <div className="admission-pages"><button disabled={!page} onClick={() => setPage(page - 1)}>{uiText("上一页")}</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{uiText("下一页")}</button></div>}
      {forced > 0 && <p className="admission-warning" role="status">{uiText("额外选择了")}{' '}{forced}{' '}{uiText("项未匹配或待确认内容：确认后会按仓库导入配置收录，即使最终仍未进入此视图也会留在仓库。")}</p>}
    </div>
    <footer><span className="muted">{uiText("未选")}{' '}{candidates.length - selected.size}{' '}{uiText("项保持原处。")}</span><button onClick={() => finish(null)}>{uiText("取消本次")}</button><button className="primary" onClick={confirm}>{selected.size ? uiText("收录所选 {size} 项{value2}", { size: String(selected.size), value2: String(forced ? uiText("（含额外选择）") : '') }) : uiText("跳过全部")}</button></footer>
  </QueryDialog>
}
