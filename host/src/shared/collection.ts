import { withTextSearch, type Cond, type Query, type QueryResult, type TextSearch } from './query'

export interface CollectionParams extends Record<string, unknown> {
  title: string
  query: Query
  /** 不指定时，在首次打开取本机本库默认；已保存视图应明确指定。 */
  layout?: string
  options?: Record<string, unknown>
  viewId?: string
  presetId?: string
  base?: { layout: string; options?: Record<string, unknown> }
}
export interface LayoutPresentation { layout: string; options: Record<string, unknown>; zoom?: number }
export interface CollectionLayoutState {
  options?: Record<string, unknown>
  zoom?: number
  anchor?: string
  /** 布局私有、可序列化的本页状态，不是素材或保存视图规则。 */
  state?: Record<string, unknown>
}
/** 只存本页交互状态；动态素材范围由调用方恢复，不写进这里。 */
export interface CollectionState {
  filters: Cond[]
  criteria?: Omit<Query, 'where'>
  presentation?: { layout: string; options: Record<string, unknown> }
  search?: string
  searchScope?: Omit<TextSearch, 'text'>
  selection: string[]
  /** 没有显式布局的新页面在首次打开时取得的默认快照。 */
  initialPresentation?: LayoutPresentation
  layouts?: Record<string, CollectionLayoutState>
  /** 旧页面存档仅在读取时接续到对应布局。 */
  anchor?: string
  zoom?: number
}
export type CollectionQueryState = Pick<CollectionState, 'filters' | 'criteria' | 'search' | 'searchScope'>

/** 标准集合及其拖入目标限定在可浏览身份；管理记录有独立页面。 */
export function browsingQuery(q: Query = {}): Query {
  return { ...q, role: q.role === 'material' || q.role === 'container' ? q.role : 'browse' }
}

/** 与标准集合相同的条件合并；zone 是布局提供的单个 JSON 条件。 */
export function collectionQuery(params: CollectionParams, state?: CollectionQueryState, zone?: string): Query {
  const q = params.query, extra = state?.criteria
  return withTextSearch({ ...browsingQuery(q),
    has: [...(q.has ?? []), ...(extra?.has ?? [])], lacks: [...(q.lacks ?? []), ...(extra?.lacks ?? [])],
    where: [...(q.where ?? []), ...(state?.filters ?? []), ...(zone ? [JSON.parse(zone) as Cond] : [])], search: [...(q.search ?? []), ...(extra?.search ?? [])],
    sort: extra?.sort ?? q.sort, dir: extra?.dir ?? q.dir
  }, { ...state?.searchScope, text: state?.search ?? '' })
}

/** 字段分面联动仅忽略同字段的临时 where 条件；基础规则、搜索及动态范围都保留。 */
export function collectionFacetQuery(params: CollectionParams, state: CollectionQueryState, kind: string, field: string, ids?: readonly string[]): Query {
  return facetScope(params, { ...state, filters: state.filters.filter(c => c.kind !== kind || c.field !== field) }, ids)
}

export function collectionBlockFacetQuery(params: CollectionParams, state: CollectionQueryState, kinds: readonly string[], ids?: readonly string[]): Query {
  const excluded = new Set(kinds)
  return facetScope(params, { ...state, criteria: { ...state.criteria, has: state.criteria?.has?.filter(k => !excluded.has(k)) } }, ids)
}

/** 原子替换一组临时块条件，不改其他插件控制的条件。 */
export function replaceHasFilters(current: readonly string[] | undefined, kinds: readonly string[], selected: readonly string[]): string[] {
  const scope = new Set(kinds)
  if (selected.some(k => !scope.has(k))) throw new Error('选中的块必须属于本分面的范围')
  return [...new Set([...(current ?? []).filter(k => !scope.has(k)), ...selected])]
}

function facetScope(params: CollectionParams, state: CollectionQueryState, ids?: readonly string[]): Query {
  const { sort: _sort, dir: _dir, ...scope } = collectionQuery(params, state)
  return scopeCollectionQuery(scope, ids)
}

/** undefined 表示不限定，空数组必须为空；与查询自带的 ids 相交，不扩大范围。 */
export function scopeCollectionQuery(query: Query, ids?: readonly string[]): Query {
  if (ids === undefined) return query
  const allowed = query.ids && new Set(query.ids)
  return { ...query, ids: [...new Set(ids)].filter(id => !allowed || allowed.has(id)) }
}
/** 范围收缩立即隐藏过期项；查询失败或尚未返回时也不能显示范围外的旧结果。 */
export function scopeCollectionResult(result: QueryResult, ids?: readonly string[]): QueryResult {
  if (ids === undefined) return result
  const allowed = new Set(ids), next: QueryResult = { ids: [], aspects: [] }
  result.ids.forEach((id, i) => { if (allowed.has(id)) { next.ids.push(id); next.aspects.push(result.aspects[i]) } })
  return next
}
