import { uiText } from '../../../shared/i18n/interface-display'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ImportReport } from '../../../shared/import-settings'
import type { ViewImportCandidate } from '../../../shared/view-import'
import { queryRules, splitConditions, type Query } from '../../../shared/query'
import { browsingQuery } from '../../../shared/collection'
import { admissionReport, type AdmissionReport } from '../admission-report'
import { importSummary } from '../import-policy'
import type { ViewImportReviewRequest } from '../components/ViewImportReview'
import type { CoreClient } from '../core-client'
import { CacheContext } from '../entity-cache'
import type { Incoming } from '../transfer-input'
import { pageInputReason } from '../../../shared/page-inputs'
import { kindOf, pageInputsFor, tabTypeOf } from '../ui-registry'
import type { ContentDropOwner } from '../content-drop'
import type { PageAccess } from './page-access'

/** 拖到标签页里的某个区域（例如看板的一列）。 */
export interface DropZone { zone: string; title: string }
export type ReceiveDestination = { type: 'page'; id: string } | { type: 'view'; id: string } | { type: 'content'; owner: ContentDropOwner }
interface IntakeOptions {
  core: CoreClient
  pages: Pick<PageAccess, 'active' | 'entry' | 'api'>
  notify(text: string): void
}

/** 窗口级收录流程：目标快照、选择、提交、准入和结果。监听输入与画面呈现由调用方负责。 */
export function useIntake({ core, pages, notify: showToast }: IntakeOptions) {
  const cache = useContext(CacheContext)!
  const [admissionReports, setAdmissionReports] = useState<AdmissionReport[]>([])
  const [importReviews, setImportReviews] = useState<ViewImportReviewRequest[]>([])
  const importReviewsRef = useRef(importReviews)
  const receiving = useRef(true)
  importReviewsRef.current = importReviews
  useEffect(() => { receiving.current = true; return () => { receiving.current = false; importReviewsRef.current.forEach(r => r.resolve(null)) } }, [])

  const reviewImport = useCallback((title: string, candidates: ViewImportCandidate[]) => new Promise<number[] | null>(resolve => {
    if (!receiving.current) { resolve(null); return }
    setImportReviews(current => [...current, { id: crypto.randomUUID(), title, candidates, resolve }])
  }), [])

  const receiveTarget = useCallback((destination: ReceiveDestination, zone?: DropZone) => {
    if (destination.type === 'view') {
      const state = cache.getSnapshot(destination.id)
      const view = state.status === 'ready' ? state.view : undefined
      const data = view?.blocks.view?.data
      if (!data || view?.deletedAt) throw new Error(uiText("目标视图已删除或尚未载入，请稍后重试"))
      // 侧栏只使用已保存规则，不附带当前页面的临时筛选。
      return { query: structuredClone(browsingQuery(data.query as Query | undefined)), title: String(data.title ?? uiText("保存的视图")) }
    }
    if (destination.type === 'content') {
      if (!zone) throw new Error(uiText("请选择工具中的接收区域"))
      const target = destination.owner.capture(zone.zone)
      return { ...target, title: zone.title || target.title }
    }
    const tabId = destination.id
    const entry = pages.entry(tabId)
    if (tabId && !entry) throw new Error(uiText("目标页面已关闭，请重新选择收录位置"))
    const type = entry && tabTypeOf(entry.type)
    const blocked = pageInputReason(pageInputsFor(entry), 'receive')
    if (blocked) throw new Error(blocked)
    return {
      query: entry && type?.dropQuery ? structuredClone(type.dropQuery(entry.params, entry.state, zone?.zone)) : undefined,
      title: [String(entry?.params.title ?? ''), zone?.title].filter(Boolean).join(' · ')
    }
  }, [cache, pages])
  const receive = useCallback(
    async (tabId: string, { paths = [], inputs = [], ids: dragged = [] }: Incoming, zone?: DropZone, target = receiveTarget({ type: 'page', id: tabId }, zone)) => {
      const { query, title } = target
      // 库里已有的文件（从卡片拖出来的）按路径认回身份；库外的收录进来
      const resolved = paths.length ? window.bridge.files.identify(paths) : []
      const recognized = paths.map((path, index) => ({ path, id: resolved[index] }))
      const existing = recognized.flatMap(p => p.id ? [p.id] : [])
      const external = recognized.filter(p => !p.id).map(p => p.path)
      let ids = [...new Set([...dragged, ...existing])]
      let imports: ImportReport | undefined
      let uncollected: ViewImportCandidate[] = []
      let summary = ''
      if (external.length || inputs.length) {
        let sources = [
          ...external.map((path) => ({ type: 'file' as const, path })), ...inputs
        ]
        const constrained = query && (queryRules(query).length || query.ids || query.scope === 'trash' || query.role === 'management')
        let allowUnmatched: number[] = []
        if (constrained) {
          const candidates = await core.previewViewImport(sources, query)
          if (!receiving.current) return
          const selected = candidates.some(c => c.status !== 'matched') ? await reviewImport(title, candidates) : candidates.map((_, i) => i)
          if (selected === null) { showToast(uiText("已取消本次收录")); return }
          const chosen = new Set(selected)
          uncollected = candidates.filter((_, i) => !chosen.has(i))
          sources = selected.map((index, position) => {
            const candidate = candidates[index], source = sources[candidate.sourceIndex]
            if (candidate.status !== 'matched') allowUnmatched.push(position)
            return candidate.path && source.type === 'file' ? { ...source, path: candidate.path } : source
          })
        }
        if (sources.length) {
          try {
            imports = constrained ? await core.importToView(sources, { requestId: crypto.randomUUID(), query: query!, allowUnmatched }) :
              await core.importToLibrary(sources, { requestId: crypto.randomUUID() })
          } catch (error) {
            const failure = error instanceof Error ? error.message : String(error)
            const report = admissionReport(title, ids, { accepted: [], rejected: ids.map(id => ({ id, reason: uiText("本批导入未完成，尚未进行视图整理") })) }, undefined, failure, uncollected)
            report.failedInputs = sources.map(source => source.type === 'file' ? source.path.split(/[\\/]/).pop() || source.path : source.type === 'bytes' ? source.name : source.text.trim().slice(0, 80) || uiText("文字内容"))
            setAdmissionReports(current => [...current, report]); return
          }
          ids = [...new Set([...ids, ...imports.items.map(item => item.id)])]
          summary = importSummary(imports)
        }
      }
      if (!ids.length) {
        if (query && (uncollected.length || imports)) setAdmissionReports(current => [...current, admissionReport(title, ids, { accepted: [], rejected: [] }, imports, undefined, uncollected)])
        else showToast(summary || uiText("没有可收录的输入"))
        return
      }
      if (!query) { if (summary) showToast(summary); return }

      // 放入视图：能写的条件写上，其余当作准入检查（设计文档 10.7）
      let admission: Awaited<ReturnType<typeof core.admit>>
      try { admission = await core.admit(ids, query) }
      catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        const report = admissionReport(title, ids, { accepted: [], rejected: ids.map(id => ({ id, reason: failure })) }, imports, failure, uncollected)
        setAdmissionReports(current => [...current, report])
        return
      }
      const { accepted, rejected } = admission
      const split = splitConditions(query, kindOf)
      const writes = (split?.write.length ?? 0) + (split?.attach.length ?? 0)
      if (rejected.length || uncollected.length || imports?.errors.length || (imports && !imports.collect && imports.saved.length)) {
        const report = admissionReport(title, ids, admission, imports, undefined, uncollected)
        setAdmissionReports(current => [...current, report])
      }
      const ingested = summary ? `；${summary}` : ''
      if (rejected.length || uncollected.length) showToast(uiText("「{title}」有未进入的内容，请查看处理结果", { title }))
      // 拖到区域里（看板换列）时，卡片换了位置就是反馈，不再提示
      else if ((writes && !zone) || !tabId || ingested) showToast(uiText("已放进「{title}」{length} 项{ingested}", { title, length: String(accepted.length), ingested }))
      if (accepted.length && tabId && tabId === pages.active() && JSON.stringify(receiveTarget({ type: 'page', id: tabId }, zone).query) === JSON.stringify(query)) pages.api(tabId)?.select?.(accepted)
    },
    [core, pages, showToast, receiveTarget, reviewImport]
  )

  /** 明确的仓库入口：不继承当前页面条件或给新素材隐式附加分面。 */
  const receiveLibrary = useCallback((incoming: Incoming) => receive('', incoming, undefined, { query: undefined, title: uiText("当前仓库") }), [receive])

  const dismissReport = useCallback((id: string) => setAdmissionReports(current => current.filter(report => report.id !== id)), [])
  const finishReview = useCallback((id: string, selected: number[] | null) => {
    const review = importReviewsRef.current.find(r => r.id === id)
    if (!review) return
    setImportReviews(current => current.filter(r => r.id !== id))
    review.resolve(selected)
  }, [])
  return { receive, receiveLibrary, captureTarget: receiveTarget, reports: admissionReports, review: importReviews[0], dismissReport, finishReview }
}

export type Intake = ReturnType<typeof useIntake>
