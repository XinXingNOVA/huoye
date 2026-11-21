import { fieldTitle, enumTitle, pluginMessages as packageMessages } from '@resource-manager/plugin-api/ui/locale'
// 看板的列：按一个单值字段分列，每一列就是"字段等于某值"的视图，再加一列"未设置"（字段为空）。
// 拖动卡片换列 = 放入那一列的视图（设计文档 10.7），不需要看板自己的写入逻辑。

import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import type { Cond } from '@resource-manager/plugin-api/query'

const uiText = packageMessages('kanban')


export interface GroupField {
  /** 选项里存的键：kind.field */
  key: string
  kind: string
  field: string
  title: string
  /** 可重建数据上的字段：只能看，拖动换列会被拒绝。 */
  readonly: boolean
  enum: boolean
}

export interface Column {
  key: string
  title: string
  cond: Cond
}

/**
 * 能分列的字段：取值是声明好的有限集合（单选、是 / 否）、建了索引、不是列表。
 * 可写的排在前面，单选排在是 / 否前面：看板主要用来推进多个阶段的状态。
 */
export function groupableFields(kinds: BlockKind[]): GroupField[] {
  const out: GroupField[] = []
  for (const k of kinds) {
    for (const [name, f] of Object.entries(k.fields)) {
      if (!f.index || f.list || (f.type !== 'enum' && f.type !== 'boolean')) continue
      if (f.type === 'enum' && !f.options?.length) continue
      out.push({ key: `${k.id}.${name}`, kind: k.id, field: name, title: fieldTitle(k, name), readonly: k.rebuildable || !!k.content || !!k.dormant, enum: f.type === 'enum' })
    }
  }
  return out.sort((a, b) => Number(a.readonly) - Number(b.readonly) || Number(b.enum) - Number(a.enum))
}

/** 选项里记的分列字段；没有记或已经不存在时，用第一个可写字段。 */
export function resolveGroupField(fields: GroupField[], key: unknown): GroupField | undefined {
  return fields.find((f) => f.key === key) ?? fields[0]
}

export function columnsFor(g: GroupField, kinds: BlockKind[]): Column[] {
  const kind = kinds.find(k => k.id === g.kind)
  const def = kind?.fields[g.field]
  if (!kind || !def) return []
  const values: (string | boolean)[] = def.type === 'boolean' ? [false, true] : (def.options ?? [])
  return [
    { key: '__empty', title: uiText("未设置"), cond: { op: 'empty', kind: g.kind, field: g.field } },
    ...values.map((v) => ({
      key: String(v),
      title: typeof v === 'boolean' ? (v ? uiText("是") : uiText("否")) : enumTitle(kind, g.field, v),
      cond: { op: 'eq' as const, kind: g.kind, field: g.field, value: v }
    }))
  ]
}
