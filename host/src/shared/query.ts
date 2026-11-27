// 查询：所有视图、筛选都建立在它上面。

export type Scope =
  | 'content' // 素材：挂有内容类数据块、不在回收站
  | 'trash' // 回收站
  | 'all' // 不在回收站的全部身份

export type Cond =
  | { op: 'eq'; kind: string; field: string; value: string | number | boolean }
  /** 同一字段任一值命中；列表字段至少一个成员命中。只查询，不推导写入。 */
  | { op: 'in'; kind: string; field: string; values: (string | number | boolean)[] }
  /** 沿关系数据的 key/parent 索引展开自身及后代；保存关系意图而非值快照。 */
  | { op: 'subtree'; kind: string; field: string; value: string; tree: { kind: string; key: string; parent: string } }
  | { op: 'range'; kind: string; field: string; min?: number; max?: number }
  /** 字段没有值（例如看板的"未设置"一列）。 */
  | { op: 'empty'; kind: string; field: string }

export type EqCond = Extract<Cond, { op: 'eq' }>
export type EmptyCond = Extract<Cond, { op: 'empty' }>
/** 能替素材写上的条件：等于某值，或单值字段为空。 */
export type WriteCond = EqCond | EmptyCond

/** 一条文字查找：不指定范围时搜全部；字段必须属于指定的数据块。 */
export interface TextSearch {
  text: string
  kind?: string
  field?: string
}

export interface Query {
  scope?: Scope
  /** material 为普通素材，container 为容器，browse 包含两者。省略时 all 含管理及从属记录，content/trash 默认 browse。 */
  role?: 'material' | 'container' | 'browse' | 'management'
  /** 必须挂有这些数据块。 */
  has?: string[]
  /** 必须没有这些数据块。 */
  lacks?: string[]
  where?: Cond[]
  /** 只在这些身份里查（例如检查准入）。 */
  ids?: string[]
  /** 全文：这些词（按空白分开）都要出现在这个身份可搜索的文字里，可以在不同的字段（设计文档 11.8）。 */
  text?: string
  /** 限定范围的文字查找，多条取交集；保留 text 以兼容已有视图。 */
  search?: TextSearch[]
  sort?: 'created' | { kind: string; field: string }
  dir?: 'asc' | 'desc'
}

/** 搜索命中的那一句：出自哪里（笔记、正文、文件名……），一段文字，词在里面的位置。 */
export interface Snippet {
  kind: string
  field: string
  label: string
  text: string
  marks: [number, number][]
}

/** 旧视图的全文条件与新搜索条件一起生效，空输入不限制素材。 */
export const searchesOf = (q: Pick<Query, 'text' | 'search'> | undefined): TextSearch[] =>
  [...(q?.text ? [{ text: q.text }] : []), ...(q?.search ?? [])].filter((s) => s.text.trim())

/** 阅读器与摘要只标出在此字段内查找的词；无效的孤立字段不能扩大为全文。 */
export const searchesField = (s: TextSearch, kind: string, field: string): boolean =>
  (!s.field || !!s.kind) && (!s.kind || s.kind === kind) && (!s.field || s.field === field)

export const searchTextFor = (q: Query | undefined, kind: string, field: string): string =>
  searchesOf(q).filter((s) => searchesField(s, kind, field)).map((s) => s.text).join(' ')

/** 叠加临时搜索时保留视图已有的每个范围。 */
export function withTextSearch(q: Query, search: TextSearch): Query {
  return search.text.trim() ? { ...q, search: [...(q.search ?? []), { ...search, text: search.text.trim() }] } : q
}

export interface QueryResult {
  ids: string[]
  /** 与 ids 一一对应的宽高比（宽 / 高），未知时为 0。 */
  aspects: number[]
}

/** 查询条件说明里用到的数据块信息。 */
export interface KindInfo {
  title: string
  rebuildable: boolean
  content?: boolean
  management?: { emptyWhen?: string }
  ownedBy?: string
  dormant?: boolean
  fields: Record<string, { title: string; list?: boolean }>
  /** 由用户的模板定义的数据块：空的一块也有意义（表示"属于这张表"）。 */
  template?: string
}

/** 放入视图：写入条件替素材写上，准入条件只检查（设计文档 10.7）。 */
export interface Admission {
  /** 不可重建、非内容类字段等于某个值（或单值字段为空）：拖入时写上。 */
  write: WriteCond[]
  /** "有某个模板"：拖入时没有的挂上一块空的（设计文档 11.4）。 */
  attach: string[]
  /** 其余条件：拖入时检查，不满足就拒绝。 */
  check: Query
}

/**
 * 把视图的查询拆成写入条件与准入条件。回收站不接受拖入，返回 undefined。
 * "有 / 没有某种数据块"、可重建字段、内容类字段、范围条件都写不了，只能当作准入条件。
 * "为空"只对单值字段写入（改成空）；列表字段写入是加入，清空整个列表不算放入，只检查。
 */
export function splitConditions(q: Query, kindOf: (id: string) => KindInfo | undefined): Admission | undefined {
  if (q.scope === 'trash' || q.role === 'management') return undefined
  const attach: string[] = []
  const has: string[] = []
  for (const k of q.has ?? []) {
    if (kindOf(k)?.template !== undefined && !kindOf(k)?.dormant) attach.push(k)
    else has.push(k)
  }
  const write: WriteCond[] = []
  const rest: Cond[] = []
  for (const c of q.where ?? []) {
    const k = kindOf(c.kind)
    const writable = !!k && !k.rebuildable && !k.content && !k.management && !k.ownedBy && !k.dormant && !!k.fields[c.field]
    if (c.op === 'subtree' && writable) {
      write.push({ op: 'eq', kind: c.kind, field: c.field, value: c.value })
      rest.push(c) // 仍校验关系可用；只写根标签，不写全部后代。
      continue
    }
    if (writable && (c.op === 'eq' || (c.op === 'empty' && !k.fields[c.field]?.list))) write.push(c)
    else rest.push(c)
  }
  // 全文条件写不了，只能检查：拖进一个"搜索结果"的视图，要含有这些词
  return { write, attach, check: { scope: q.scope, role: q.role, ...(q.ids ? { ids: q.ids } : {}), has: q.has && has, lacks: q.lacks, where: rest, text: q.text, search: q.search } }
}

/** 准入条件是否为空（只有写入条件的视图：拖进去的都接受）。 */
export const noChecks = (q: Query) => q.ids === undefined && !q.has?.length && !q.lacks?.length && !q.where?.length && !searchesOf(q).length

export function searchScopeLabel(s: Pick<TextSearch, 'kind' | 'field'>, kindOf: (id: string) => KindInfo | undefined): string {
  if (!s.kind) return '全部内容'
  const kind = kindOf(s.kind)
  return `${kind?.title ?? s.kind}${s.field ? ` · ${kind?.fields[s.field]?.title ?? s.field}` : ''}`
}

/** 一个条件的可读说明，用于拒绝时告诉用户哪一条不满足。 */
export function describeCondition(
  c: Cond | { has: string } | { lacks: string } | TextSearch,
  kindOf: (id: string) => KindInfo | undefined
): string {
  if ('text' in c) return `${c.kind ? `${searchScopeLabel(c, kindOf)}中` : ''}含有「${c.text}」`
  if ('has' in c) return `有${kindOf(c.has)?.title ?? c.has}`
  if ('lacks' in c) return `没有${kindOf(c.lacks)?.title ?? c.lacks}`
  const field = kindOf(c.kind)?.fields[c.field]?.title ?? c.field
  if (c.op === 'empty') return `${field}为空`
  if (c.op === 'subtree') return `${field}为「${c.value}」或其下级`
  if (c.op === 'in') return `${field}为 ${c.values.map(v => `「${String(v)}」`).join(' 或 ')}`
  if (c.op === 'eq') {
    const value = typeof c.value === 'boolean' ? (c.value ? '是' : '否') : String(c.value)
    return `${field}为「${value}」`
  }
  if (c.min !== undefined && c.max !== undefined) return `${field}在 ${c.min}–${c.max} 之间`
  return c.min !== undefined ? `${field} ≥ ${c.min}` : `${field} ≤ ${c.max}`
}

/** 无 query 时统计全库未删除的素材身份；显式 query 完整遵循查询范围。limit 仅限制返回的值数量。 */
export interface FacetOptions { query?: Query; limit?: number }

export interface FacetItem {
  value: string
  count: number
}

/** 规则说明与拖入提示共用；写入语义与 splitConditions 一致。 */
export type QueryRule = Cond | { has: string } | { lacks: string } | TextSearch
export function queryRules(q: Query): QueryRule[] {
  return [...(q.has ?? []).map(has => ({ has })), ...(q.lacks ?? []).map(lacks => ({ lacks })), ...(q.where ?? []), ...searchesOf(q)]
}
export function withRules(q: Query, rules: QueryRule[]): Query {
  return { ...q, text: undefined, has: rules.flatMap(r => 'has' in r ? [r.has] : []), lacks: rules.flatMap(r => 'lacks' in r ? [r.lacks] : []), where: rules.flatMap(r => 'op' in r ? [r] : []), search: rules.flatMap(r => 'text' in r ? [r] : []) }
}
