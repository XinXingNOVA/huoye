import { uiText } from '../../shared/i18n/interface-display'
import type { ImportReport } from '../../shared/import-settings'
import type { ViewImportCandidate } from '../../shared/view-import'

export type AdmissionOrigin = 'created' | 'restored' | 'existing'
export interface AdmissionReport {
  id: string
  title: string
  accepted: string[]
  rejected: { id: string; reason: string; origin: AdmissionOrigin }[]
  /** 检查／写入异常不能伪装成条件不匹配。 */
  warnings?: string[]
  failure?: string
  imports?: ImportReport
  uncollected: ViewImportCandidate[]
  failedInputs?: string[]
}
type Result = { accepted: string[]; rejected: { id: string; reason: string }[] }

export function admissionReport(title: string, ids: string[], result: Result, imports?: ImportReport, failure?: string, uncollected: ViewImportCandidate[] = []): AdmissionReport {
  const origin = new Map<string, AdmissionOrigin>(ids.map(id => [id, 'existing']))
  const priority = { existing: 0, restored: 1, created: 2 }
  for (const item of imports?.items ?? []) {
    if (priority[item.outcome] > priority[origin.get(item.id) ?? 'existing']) origin.set(item.id, item.outcome)
  }
  return {
    id: crypto.randomUUID(), title: title || uiText("目标视图"), imports, failure, uncollected,
    accepted: [...new Set(result.accepted)],
    rejected: [...new Map(result.rejected.map(item => [item.id, { ...item, origin: origin.get(item.id) ?? 'existing' }])).values()]
  }
}

export function rejectionState(report: AdmissionReport): string {
  const count = (origin: AdmissionOrigin) => report.rejected.filter(item => item.origin === origin).length
  return [count('created') ? uiText("{value1} 项已新增到仓库", { value1: String(count('created')) }) : '',
    count('restored') ? uiText("{value1} 项已从仓库回收站恢复", { value1: String(count('restored')) }) : '',
    count('existing') ? uiText("{value1} 项原本就在仓库", { value1: String(count('existing')) }) : ''].filter(Boolean).join('；')
}

export function rejectionReasons(report: AdmissionReport): { reason: string; count: number }[] {
  const reasons = new Map<string, number>()
  for (const row of report.rejected) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1)
  return [...reasons].map(([reason, count]) => ({ reason, count }))
}
