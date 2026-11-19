import type { Query } from '../../shared/query'
import type { CollectionSessionApi, CollectionSessionSnapshot, LayoutSession } from '../../shared/workbench-session'

/** 记录已提交的页面现场。查询失效、返回和布局提交分别计数，不把旧卡片误报为新查询。 */
export class CollectionSession implements CollectionSessionApi {
  private instanceId = crypto.randomUUID()
  private contextVersion = 0
  private signature = ''
  private query: Query = {}
  private layout = ''
  private supported = false
  private selected: string[] = []
  private ids: string[] = []
  private requested = 0
  private result = -1
  private rendered = -1
  private renderedIds: string[] = []
  private error?: string
  private highlight: string[] = []
  private revealRequest?: { token: string; id: string }
  private revealed?: string
  constructor(private present: (ids: string[], reveal?: { token: string; id: string }) => void) {}
  configure(query: Query, selected: string[], layout: string, supported: boolean) {
    const signature = JSON.stringify([query, selected, layout, supported])
    if (signature !== this.signature) { this.signature = signature; this.contextVersion++ }
    if (JSON.stringify(query) !== JSON.stringify(this.query) || layout !== this.layout || supported !== this.supported) {
      this.invalidate(); this.rendered = -1; this.renderedIds = []; this.clear()
    }
    this.query = query; this.selected = selected; this.layout = layout; this.supported = supported
  }
  invalidate() { this.error = undefined; return ++this.requested }
  accept(revision: number, ids: string[], error?: string) {
    if (revision !== this.requested) return
    this.result = revision; this.ids = ids; this.error = error
  }
  onRendered: LayoutSession['onRendered'] = ({ revision, ids, revealToken }) => {
    // 子布局 layoutEffect 可早于父集合的提交回报；读取时仍要求三方版本一致。
    this.rendered = revision; this.renderedIds = ids
    if (this.revealRequest && revealToken === this.revealRequest.token && ids.includes(this.revealRequest.id)) this.revealed = revealToken
  }
  clear() { this.highlight = []; this.revealRequest = undefined; this.revealed = undefined; this.present([]) }
  read(): CollectionSessionSnapshot {
    const queryTruncated = JSON.stringify(this.query).length > 16000
    const state = this.result !== this.requested ? 'querying' : this.error ? 'error' : !this.supported ? 'unsupported' : this.rendered !== this.result ? 'rendering' : 'ready'
    return { instanceId: this.instanceId, contextVersion: this.contextVersion, ...(queryTruncated ? {} : { query: this.query }), queryTruncated,
      layout: this.layout, selectedIds: this.selected.slice(0, 1000), selectedCount: this.selected.length, selectionTruncated: this.selected.length > 1000,
      resultCount: this.ids.length, queryVersion: this.requested, resultVersion: this.result, renderedVersion: this.supported && this.rendered >= 0 ? this.rendered : null, state,
      ...(this.error ? { error: this.error.slice(0, 2000) } : {}), renderedIds: this.renderedIds.slice(0, 100), renderedCount: this.renderedIds.length, renderedTruncated: this.renderedIds.length > 100,
      highlightedIds: this.highlight, ...(this.revealRequest ? { reveal: { token: this.revealRequest.token, state: this.revealed === this.revealRequest.token ? 'rendered' : 'pending' } as const } : {}) }
  }
  reveal(ids: string[]) {
    const snapshot = this.read()
    if (snapshot.state === 'unsupported') throw new Error('[LAYOUT_UNSUPPORTED] 当前布局尚未支持定位与渲染回执')
    if (snapshot.state !== 'ready') throw new Error('[WORKBENCH_NOT_READY] 当前查询尚未渲染完成')
    const available = new Set(this.ids)
    if (ids.some(id => !available.has(id))) throw new Error('[ITEM_NOT_IN_VIEW] 素材不在当前结果内，请另开结果页')
    this.highlight = [...new Set(ids)]; this.revealRequest = { token: crypto.randomUUID(), id: ids[0] }
    this.present(this.highlight, this.revealRequest)
    return { token: this.revealRequest.token }
  }
}
