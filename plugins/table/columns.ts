import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import type { Query } from '@resource-manager/plugin-api/query'
import type { TableColumn } from './contract'

export interface ColumnRef { kind: string; field: string }
export interface ResolvedColumn { ref: ColumnRef; column?: TableColumn }
export const columnKey = (ref: ColumnRef) => JSON.stringify([ref.kind, ref.field])
export const defaultColumns: ColumnRef[] = [['status','value'],['tags','values'],['file','ext'],['file','size']].map(([kind,field]) => ({ kind,field }))
export const focusTemplate = (query: Query, kinds: BlockKind[]) => (query.has ?? []).map(id => kinds.find(k => k.id === id)).find(k => k?.template !== undefined)
export function readColumns(value: unknown): ColumnRef[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(ref => {
    if (!ref || typeof ref.kind !== 'string' || !ref.kind || typeof ref.field !== 'string' || !ref.field) return []
    const key = columnKey(ref)
    if (seen.has(key) || seen.size >= 200) return []
    seen.add(key); return [{ kind: ref.kind, field: ref.field }]
  })
}
/** 候选只读公开定义；内部 JSON 和文件定位字段不作为可选列。已有自定义引用始终保留。 */
export function availableColumns(kinds: BlockKind[]): TableColumn[] {
  return kinds.filter(k => !k.management).flatMap(kind => Object.entries(kind.fields)
    .filter(([,def]) => def.type !== 'json' && !def.file).map(([field,def]) => ({kind,field,def})))
}
export function resolveColumns(options: Record<string, unknown>, query: Query, kinds: BlockKind[]): ResolvedColumn[] {
  const focus = focusTemplate(query, kinds), custom = options.columnMode === 'custom'
  const refs = custom ? readColumns(options.columns) : focus ? Object.keys(focus.fields).map(field => ({kind:focus.id,field})) : defaultColumns
  const definitions = new Map(kinds.map(k => [k.id,k]))
  return refs.flatMap(ref => {
    const kind = definitions.get(ref.kind), def = kind?.fields[ref.field]
    if (kind && def) return [{ ref, column: {kind,field:ref.field,def} }]
    return custom ? [{ref}] : []
  })
}
/** 移动至目标位置；越界和无效身份保持原配置。 */
export function moveColumn(refs: ColumnRef[], from: number, to: number): ColumnRef[] {
  if (from < 0 || to < 0 || from >= refs.length || to >= refs.length || from === to) return refs
  const next = [...refs], [item] = next.splice(from,1); next.splice(to,0,item); return next
}
