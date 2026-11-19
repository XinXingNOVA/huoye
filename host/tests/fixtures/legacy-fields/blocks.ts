// 自定义字段插件的数据定义（设计文档 11.4）。
// 模板是一个身份，挂一块模板块（名称 + 字段列表）；每个模板定义一种数据块 tpl:<模板身份>。
// 插件用代码定义数据块，这个插件让用户用数据定义数据块。

import type { BlockData, BlockKind, FieldDef } from '../../../src/shared/blocks'

/** 字段类型：用户看到的类型，都落在已有的值类型上。 */
export type FieldType = 'text' | 'longtext' | 'number' | 'select' | 'multi' | 'date' | 'checkbox' | 'rating' | 'url'

export const FIELD_TYPES: { id: FieldType; title: string }[] = [
  { id: 'text', title: '文本' },
  { id: 'longtext', title: '长文本' },
  { id: 'number', title: '数字' },
  { id: 'select', title: '单选' },
  { id: 'multi', title: '多选' },
  { id: 'date', title: '日期' },
  { id: 'checkbox', title: '复选框' },
  { id: 'rating', title: '评分' },
  { id: 'url', title: '链接' }
]

export interface FieldSpec {
  /** 稳定的内部 ID：改名不用迁移数据。 */
  id: string
  title: string
  type: FieldType
  /** 单选、多选的选项。 */
  options?: string[]
  /** 评分的满分，默认 5。 */
  max?: number
}

export interface TemplateData {
  title: string
  fields: FieldSpec[]
}

const FIELD_ID = /^f[a-z0-9]{2,15}$/

/** 模板块的结构约束：字段 ID 唯一、类型已知、选项不重复。 */
export function validateTemplate(data: BlockData): void {
  if (typeof data.title !== 'string' || !data.title.trim()) throw new Error('模板需要名称')
  const fields = data.fields ?? []
  if (!Array.isArray(fields)) throw new Error('模板的字段应为列表')
  const ids = new Set<string>()
  for (const f of fields as FieldSpec[]) {
    if (!f || typeof f.id !== 'string' || !FIELD_ID.test(f.id)) throw new Error(`字段 ID 无效：${JSON.stringify(f?.id)}`)
    if (ids.has(f.id)) throw new Error(`字段 ID 重复：${f.id}`)
    ids.add(f.id)
    if (typeof f.title !== 'string' || !f.title.trim()) throw new Error('字段需要名称')
    if (!FIELD_TYPES.some((t) => t.id === f.type)) throw new Error(`未知的字段类型：${f.type}`)
    if (f.type === 'select' || f.type === 'multi') {
      const options = f.options ?? []
      if (!Array.isArray(options) || options.some((o) => typeof o !== 'string' || !o.trim())) throw new Error(`字段「${f.title}」的选项无效`)
      if (new Set(options).size !== options.length) throw new Error(`字段「${f.title}」有重复的选项`)
    }
    if (f.max !== undefined && (!Number.isInteger(f.max) || f.max < 1 || f.max > 10)) throw new Error(`字段「${f.title}」的满分应为 1–10`)
  }
}

/**
 * 模板块：不可重建、非内容类，所以模板身份不会出现在"全部"里。
 * 字段列表存成 json，结构由 validateTemplate 约束。
 */
export const templateBlock: BlockKind = {
  id: 'template',
  display: { title: 'title', priority: 0 },
  plugin: 'fields',
  title: '模板',
  rebuildable: false,
  standalone: true,
  management: {},
  version: 1,
  fields: {
    title: { type: 'text', title: '名称', index: true },
    fields: { type: 'json', title: '字段' }
  },
  validate: validateTemplate
}

export const templateKindId = (templateId: string) => `tpl:${templateId}`

/** 字段类型 → 值类型。除了长文本，都建索引：都能筛选、排序、分面。 */
export function fieldDef(f: FieldSpec): FieldDef {
  switch (f.type) {
    case 'text':
      return { type: 'text', title: f.title, index: true, search: true }
    case 'longtext':
      return { type: 'longtext', title: f.title, search: true }
    case 'number':
      return { type: 'number', title: f.title, index: true }
    case 'select':
      return { type: 'enum', title: f.title, options: f.options ?? [], index: true }
    case 'multi':
      return { type: 'enum', title: f.title, options: f.options ?? [], list: true, index: true }
    case 'date':
      return { type: 'date', title: f.title, index: true }
    case 'checkbox':
      return { type: 'boolean', title: f.title, index: true }
    case 'rating':
      return { type: 'number', title: f.title, index: true, format: 'rating', min: 1, max: f.max ?? 5 }
    case 'url':
      return { type: 'text', title: f.title, index: true, format: 'url' }
  }
}

/** 一个模板定义的数据块。字段的顺序就是模板里的顺序。 */
export function templateKind(templateId: string, data: BlockData): BlockKind {
  const t = data as unknown as TemplateData
  return {
    id: templateKindId(templateId),
    plugin: 'fields',
    title: t.title,
    rebuildable: false,
    version: 1,
    template: templateId,
    fields: Object.fromEntries((t.fields ?? []).map((f) => [f.id, fieldDef(f)]))
  }
}

/** 新字段的 ID：不和已有的重复。 */
export function newFieldId(existing: FieldSpec[]): string {
  const taken = new Set(existing.map((f) => f.id))
  for (;;) {
    const id = `f${Math.random().toString(36).slice(2, 8)}`
    if (FIELD_ID.test(id) && !taken.has(id)) return id
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [templateBlock]
