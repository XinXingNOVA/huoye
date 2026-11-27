import { uiText } from '../../../shared/i18n/interface-display'
import { useCallback, useContext, useEffect, useRef } from 'react'
import type { ImportReport } from '../../../shared/import-settings'
import type { ViewImportCandidate } from '../../../shared/view-import'
import { queryRules, splitConditions, type Query } from '../../../shared/query'
import { browsingQuery } from '../../../shared/collection'
import { admissionReport, type AdmissionReport } from '../admission-report'
import { importSummary } from '../import-policy'
import { emitBatch, useIntakeFeedback, type ReceiveBatch } from './intake-feedback'
import type { CoreClient } from '../core-client'
import { CacheContext } from '../entity-cache'
import type { Incoming, TransferEntry } from '../transfer-input'
import { receiveItems } from '../receive-items'
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
  notify(text: string, doc?: Document): void
}

/** 窗口级收录流程：目标快照、选择、提交、准入和结果。监听输入与画面呈现由调用方负责。 */
export function useIntake({ core, pages, notify: showToast }: IntakeOptions) {
  const cache = useContext(CacheContext)!
  const feedback = useIntakeFeedback()
  const { reviewImport, addReport } = feedback
  const receiving = useRef(true)
  useEffect(() => { receiving.current = true; return () => { receiving.current = false } }, [])

  const receiveTarget = useCallback((destination: ReceiveDestination, zone?: DropZone) => {
    const viewId = destination.type === 'view' ? destination.id : destination.type === 'content' && destination.owner.kind === 'view' ? destination.owner.viewId() : undefined
    if (viewId !== undefined) {
      const state = cache.getSnapshot(viewId)
      const view = state.status === 'ready' ? state.view : undefined
      const data = view?.blocks.view?.data
      if (!data || view?.deletedAt) throw new Error(uiText("目标视图已删除或尚未载入，请稍后重试"))
      // 侧栏只使用已保存规则，不附带当前页面的临时筛选。
      return { query: structuredClone(browsingQuery(data.query as Query | undefined)), title: String(data.title ?? uiText("保存的视图")) }
    }
    if (destination.type === 'content') {
      if (!zone || destination.owner.kind !== 'query') throw new Error(uiText("请选择工具中的接收区域"))
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
    async (tabId: string, { paths = [], inputs = [], ids: dragged = [] }: Incoming, zone?: DropZone, target = receiveTarget({ type: 'page', id: tabId }, zone), batch?: ReceiveBatch, warnings: string[] = [], doc?: Document) => {
      const { query, title } = target
      function complete(report: AdmissionReport, needsDetail: boolean) {
        if (warnings.length) { report.warnings = warnings; needsDetail = true }
        if (batch) report.id = batch.id
        const details = needsDetail ? addReport(report) : undefined
        if (batch) emitBatch(batch, { phase: 'done', accepted: report.accepted.length, rejected: report.rejected.length,
          skipped: report.uncollected.length, savedOnly: report.imports?.collect === false ? report.imports.saved.length : 0,
          errors: (report.imports?.errors.length ?? 0) + warnings.length + (report.failure ? 1 : 0),
          message: report.failure ?? warnings[0], ...details })
      }
      const notify = (message: string) => { if (!batch) showToast(message, doc) }
      const cancelled = () => {
        if (batch) emitBatch(batch, { phase: 'cancelled' })
        else notify(uiText("已取消本次收录"))
      }
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
        const constrained = query && (batch || queryRules(query).length || query.ids || query.scope === 'trash' || query.role === 'management')
        let allowUnmatched: number[] = []
        if (constrained) {
          const candidates = await core.previewViewImport(sources, query)
          if (!receiving.current) return
          const needsReview = candidates.some(c => c.status !== 'matched')
          const selected = needsReview ? await reviewImport(title, candidates, batch) : candidates.map((_, i) => i)
          if (selected === null) { cancelled(); return }
          if (batch && needsReview) emitBatch(batch, { phase: 'processing' })
          const chosen = new Set(selected)
          uncollected = candidates.filter((_, i) => !chosen.has(i))
          sources = selected.map((index, position) => {
            const candidate = candidates[index], source = sources[candidate.sourceIndex]
            if (candidate.status !== 'matched') allowUnmatched.push(position)
            return candidate.path && source.type === 'file' ? { ...source, path: candidate.path } : source
          })
        }
        if (batch?.surface.signal.aborted) { cancelled(); return }
        if (sources.length) {
          try {
            imports = constrained ? await core.importToView(sources, { requestId: batch?.id ?? crypto.randomUUID(), query: query!, viewId: batch?.viewId, allowUnmatched }) :
              await core.importToLibrary(sources, { requestId: crypto.randomUUID() })
          } catch (error) {
            const failure = error instanceof Error ? error.message : String(error)
            const report = admissionReport(title, ids, { accepted: [], rejected: ids.map(id => ({ id, reason: uiText("本批导入未完成，尚未进行视图整理") })) }, undefined, failure, uncollected)
            report.failedInputs = sources.map(source => source.type === 'file' ? source.path.split(/[\\/]/).pop() || source.path : source.type === 'bytes' ? source.name : source.text.trim().slice(0, 80) || uiText("文字内容"))
            complete(report, true); return
          }
          ids = [...new Set([...ids, ...imports.items.map(item => item.id)])]
          summary = importSummary(imports)
        }
      }
      if (!ids.length) {
        if (query && (batch || uncollected.length || imports)) complete(admissionReport(title, ids, { accepted: [], rejected: [] }, imports, undefined, uncollected), !!(uncollected.length || imports || warnings.length))
        else notify(summary || uiText("没有可收录的输入"))
        return
      }
      if (!query) { if (summary) notify(summary); return }

      // 放入视图：能写的条件写上，其余当作准入检查（设计文档 10.7）
      let admission: Awaited<ReturnType<typeof core.admit>>
      try { admission = await core.admit(ids, query, batch?.viewId) }
      catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        const report = admissionReport(title, ids, { accepted: [], rejected: ids.map(id => ({ id, reason: failure })) }, imports, failure, uncollected)
        complete(report, true)
        return
      }
      const { accepted, rejected } = admission
      const split = splitConditions(query, kindOf)
      const writes = (split?.write.length ?? 0) + (split?.attach.length ?? 0)
      if (rejected.length || uncollected.length || imports?.errors.length || (imports && !imports.collect && imports.saved.length)) {
        const report = admissionReport(title, ids, admission, imports, undefined, uncollected)
        complete(report, true)
      } else if (batch || warnings.length) complete(admissionReport(title, ids, admission, imports), false)
      const ingested = summary ? `；${summary}` : ''
      if (rejected.length || uncollected.length) notify(uiText("「{title}」有未进入的内容，请查看处理结果", { title }))
      // 拖到区域里（看板换列）时，卡片换了位置就是反馈，不再提示
      else if ((writes && !zone) || !tabId || ingested) notify(uiText("已放进「{title}」{length} 项{ingested}", { title, length: String(accepted.length), ingested }))
      if (!batch && accepted.length && tabId && tabId === pages.active() && JSON.stringify(receiveTarget({ type: 'page', id: tabId }, zone).query) === JSON.stringify(query)) pages.api(tabId)?.select?.(accepted)
    },
    [core, pages, showToast, receiveTarget, reviewImport, addReport]
  )

  /** 明确的仓库入口：不继承当前页面条件或给新素材隐式附加分面。 */
  const receiveLibrary = useCallback((incoming: Incoming) => receive('', incoming, undefined, { query: undefined, title: uiText("当前仓库") }), [receive])

  const collectItems = useCallback((entries: TransferEntry[]) => receiveItems(entries, core, window.bridge.files.identify), [core])
  return { receive, collectItems, receiveLibrary, captureTarget: receiveTarget, ...feedback }
}

export type Intake = ReturnType<typeof useIntake>
