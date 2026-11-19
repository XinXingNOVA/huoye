import type { Cond } from '../../shared/query'
import type { Workspace } from './workspace'
import type { EntityState } from '../../plugin-api/ui/entities'
export { collectionQuery as effectiveQuery } from '../../shared/collection'
export type { CollectionQueryState } from '../../shared/collection'
export const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
/** 页面存档可能留下重复临时条件；只合并完整相同的条件，不猜测用户想保留哪个标签。 */
export function uniqueCollectionFilters(filters: readonly Cond[]): Cond[] {
  const seen = new Set<string>()
  return filters.filter(cond => { const key = canonical(cond); if (seen.has(key)) return false; seen.add(key); return true })
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** 保存规则是打开页共同的来源，冻结页也要更新；局部 state 一律不覆盖。 */
export function syncViewSource(w: Workspace, id: string, state: EntityState): Workspace {
  if (state.status !== 'ready' && state.status !== 'missing') return w
  const view = state.view, data = view?.blocks.view?.data
  let changed = false
  const tabs = w.tabs.map(t => {
    if (t.type !== 'collection' || t.params.viewId !== id) return t
    const params = !data || view?.deletedAt ? { ...t.params, viewId: undefined } : { ...t.params, title: String(data.title), query: data.query ?? {}, layout: String(data.layout ?? 'masonry'), options: data.options ?? {} }
    if (sameValue(t.params, params)) return t
    changed = true
    return { ...t, params }
  })
  return changed ? { ...w, tabs } : w
}

/** 普通列表筛选可累加；显式独占只替换同字段临时条件，其他字段原样保留。 */
export function toggleCollectionFilter(filters: Cond[], condition: Cond, list: boolean, exclusive = false): Cond[] {
  const sameField = (c: Cond) => c.kind === condition.kind && c.field === condition.field
  const current = filters.filter(sameField)
  const matching = current.some(c => sameValue(c, condition))
  if (exclusive) {
    const others = filters.filter(c => !sameField(c))
    return current.length === 1 && matching ? others : [...others, condition]
  }
  if (matching) return filters.filter(c => !sameValue(c, condition))
  return [...(list ? filters : filters.filter(c => !sameField(c))), condition]
}
