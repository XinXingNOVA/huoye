import { sessionPresentSchema, sessionReadSchema, type SessionRequest, type SessionWindows } from '../../shared/workbench-session'
import type { CoreClient } from './core-client'
import type { PageAccess } from './app/page-access'
import { collectionTab, newTabId, type CollectionParams, type TabEntry, type Workspace } from './workspace'
import { editorsOf, groupOf, type EditorOpenTarget } from './editor-layout'
import { querySchema } from '../../shared/query-input'

/** 排除滚动、卡片尺寸等存档变化；页面切走再切回仍增加 epoch。 */
export function workspaceContextChanged(a: Workspace, b: Workspace) {
  return a.active !== b.active || a.tabs.length !== b.tabs.length || a.tabs.some((t, i) => {
    const n = b.tabs[i]
    return t.id !== n.id || t.type !== n.type || t.params !== n.params || t.presentationRevision !== n.presentationRevision
  }) || JSON.stringify(editorsOf(a).groups.map(g => [g.id, g.active, g.tabs, !!g.window])) !== JSON.stringify(editorsOf(b).groups.map(g => [g.id, g.active, g.tabs, !!g.window]))
}
interface Options {
  read(): Workspace | undefined
  epoch(): number
  busy(): boolean
  pages: PageAccess
  core: Pick<CoreClient, 'get' | 'reviewBatch'>
  open(entry: TabEntry, target: EditorOpenTarget): void
}
export function createWorkbenchSession(options: Options) {
  const sessionId = crypto.randomUUID()
  const receipts = new Map<string, { signature: string; result: { requestId: string; tabId: string; state: 'accepted'; revealToken?: string } }>()
  let applying = false
  const read = (input: ReturnType<typeof sessionReadSchema.parse>, windows: SessionWindows) => {
    const ws = options.read()
    if (!ws || options.busy()) throw new Error('[WORKBENCH_NOT_READY] 工作台仍在加载或处理页面切换')
    const groups = editorsOf(ws).groups
    const page = (entry: TabEntry) => {
      const group = groupOf(ws, entry.id)!
      return { id: entry.id, type: entry.type, title: String(entry.params.title ?? entry.type).slice(0, 200), groupId: group.id,
        windowId: group.window ? `content:${group.id}` : 'main', active: ws.active === entry.id, visible: group.active === entry.id }
    }
    const entry = ws.tabs.find(t => t.id === (input.tabId ?? ws.active))
    if (!entry) throw new Error('[PAGE_NOT_FOUND] 标签页已关闭')
    const target = page(entry)
    const collection = target.visible ? options.pages.api(entry.id)?.collectionSession?.read() : undefined
    const selected = collection?.selectedIds ?? options.pages.focus(entry.id).slice(0, 1000)
    const contextRevision = `${options.epoch()}:${entry.id}:${collection ? `${collection.instanceId}:${collection.contextVersion}` : 'page'}`
    return { sessionId, expected: { sessionId, contextRevision, tabId: entry.id, windowRevision: windows.revision },
      activeTabId: ws.active, windows, target: { ...target, state: !target.visible ? 'inactive' : collection ? 'collection' : entry.type === 'collection' ? 'loading' : 'unsupported', selectedIds: selected,
        selectedCount: collection?.selectedCount ?? options.pages.focus(entry.id).length, selectionTruncated: collection?.selectionTruncated ?? options.pages.focus(entry.id).length > 1000, ...(collection ? { collection } : {}) },
      tabs: ws.tabs.slice(input.offset, input.offset + input.limit).map(page), tabCount: ws.tabs.length,
      nextOffset: input.offset + input.limit < ws.tabs.length ? input.offset + input.limit : null,
      groups: groups.slice(0, 50).map(g => ({ id: g.id, activeTabId: g.active, windowId: g.window ? `content:${g.id}` : 'main' })), groupsTruncated: groups.length > 50 }
  }
  return async (request: SessionRequest, windows: SessionWindows, authorize: () => Promise<void>) => {
    if (request.action === 'read') return read(sessionReadSchema.parse(request.input), windows)
    const input = sessionPresentSchema.parse(request.input)
    if (input.expected.sessionId !== sessionId) throw new Error('[SESSION_CHANGED] 工作台已重载，请重新读取现场')
    const signature = JSON.stringify(input), previous = receipts.get(input.requestId)
    if (previous) {
      if (signature !== previous.signature) throw new Error('[REQUEST_CONFLICT] 此请求已经用于另一展示操作')
      return { ...previous.result, replayed: true }
    }
    if (applying) throw new Error('[WORKBENCH_BUSY] 仍在处理上一次展示请求')
    const check = () => {
      const snapshot = read(sessionReadSchema.parse({ tabId: input.expected.tabId }), windows)
      if (snapshot.expected.contextRevision !== input.expected.contextRevision) throw new Error('[CONTEXT_CHANGED] 用户已切换页面、筛选或选区，请重新读取现场')
      if (!snapshot.target.visible) throw new Error('[PAGE_NOT_VISIBLE] 目标标签页当前未显示')
      return snapshot
    }
    applying = true
    try {
      check()
      let params: CollectionParams | undefined
      if (input.target.action === 'open') params = { title: input.target.title, query: input.target.query, layout: 'masonry' }
      if (input.target.action === 'open_view') {
        const view = (await options.core.get([input.target.viewId]))[0], data = view?.blocks.view?.data
        if (!view || view.deletedAt || !data) throw new Error('[VIEW_NOT_FOUND] 保存视图不存在或已删除')
        params = { viewId: view.id, title: String(data.title), query: querySchema.parse(data.query), layout: typeof data.layout === 'string' ? data.layout : 'masonry',
          options: data.options && typeof data.options === 'object' && !Array.isArray(data.options) ? data.options as Record<string, unknown> : {} }
      }
      let review: TabEntry | undefined
      if (input.target.action === 'open_review') {
        const result = await options.core.reviewBatch({ action: 'get', batchId: input.target.batchId, limit: 1 })
        if (!('batch' in result)) throw new Error('[REVIEW_UNAVAILABLE] 验收单不可用')
        review = options.read()?.tabs.find(t => t.type === 'batch-review' && t.params.batchId === result.batch.id)
          ?? { id: newTabId(), type: 'batch-review', params: { batchId: result.batch.id, title: result.batch.title } }
      }
      await authorize()
      const snapshot = check()
      let tabId = snapshot.target.id, revealToken: string | undefined
      if (input.target.action === 'reveal') {
        const api = options.pages.api(tabId)?.collectionSession
        if (!api) throw new Error('[PAGE_UNSUPPORTED] 当前页面尚未支持集合定位')
        revealToken = api.reveal(input.target.ids).token
      } else {
        const entry = review ?? collectionTab(params!)
        options.open(entry, { group: snapshot.target.groupId })
        if (!options.pages.entry(entry.id)) throw new Error('[WORKBENCH_BUSY] 工作台未接纳新页面')
        tabId = entry.id
      }
      const result = { requestId: input.requestId, tabId, state: 'accepted' as const, ...(revealToken ? { revealToken } : {}) }
      receipts.set(input.requestId, { signature, result })
      if (receipts.size > 50) receipts.delete(receipts.keys().next().value!)
      return { ...result, replayed: false }
    } finally { applying = false }
  }
}
