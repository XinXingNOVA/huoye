import { toolIdOf } from './workspace'
import type { PageContext, CollectionFilterCapability } from '../../plugin-api/ui/page-context'
import type { PageAccess } from './app/page-access'

/** 当前页面能力快照；写动作始终按来源 ID 解析，不改用当时的活动页。 */
export function pageContext(pages: PageAccess, id: string): PageContext | undefined {
  const entry = pages.entry(id), api = pages.api(id)
  if (!entry || toolIdOf(entry)) return
  const live = () => pages.entry(id)?.type === entry.type && !!pages.api(id)
  const capabilities: Record<string, unknown> = { ...api?.context?.capabilities }
  // 保留集合已有接口；旧页面只有完整声明这两个能力才作为集合筛选目标。
  delete capabilities['collection.filter']
  if (api?.facetQuery && api.toggleFilter) {
    const filter: CollectionFilterCapability = {
      filters: api.filters,
      has: api.has,
      facetQuery: (kind, field) => { const query = live() && pages.api(id)?.facetQuery; return query ? query(kind, field) : { ids: [] } },
      blockFacetQuery: api.blockFacetQuery ? kinds => { const query = live() && pages.api(id)?.blockFacetQuery; return query ? query(kinds) : { ids: [] } } : undefined,
      toggleFilter: (cond, options) => { if (live()) pages.api(id)?.toggleFilter?.(cond, options) },
      setHasFilters: api.setHasFilters ? (kinds, selected) => { if (live()) pages.api(id)?.setHasFilters?.(kinds, selected) } : undefined
    }
    capabilities['collection.filter'] = filter
  }
  return { pageId: id, type: entry.type, title: api?.context?.title || String(entry.params.title ?? entry.params.name ?? '当前页面'),
    selection: pages.focus(id), capabilities, isAvailable: live }
}
