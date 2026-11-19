import { z } from 'zod'
import { normalizeBlock, type BlockData, type BlockKind } from '../shared/blocks'
import type { CorePlugin } from '../plugin-api/core/contracts'

// 第一版只开放可保存为快照的附加字段；文件所有权、身份生命周期和自定义函数不在此契约中。
const fieldSchema = z.object({
  type: z.enum(['text', 'longtext', 'number', 'boolean', 'date', 'enum', 'color', 'json']),
  title: z.string(), list: z.boolean().optional(), options: z.array(z.string()).optional(),
  index: z.boolean().optional(), search: z.boolean().optional(),
  format: z.enum(['duration', 'bytes', 'px', 'rating', 'url', 'markdown']).optional(),
  min: z.number().optional(), max: z.number().optional()
}).strict().superRefine((f, ctx) => {
  if ((f.type === 'json' && f.index) || (f.search && !['text', 'longtext'].includes(f.type)) ||
    (f.min !== undefined && f.max !== undefined && f.min > f.max)) ctx.addIssue({ code: 'custom', message: '动态字段的索引、搜索或数值范围无效' })
})
const kindSchema = z.object({
  id: z.string(), plugin: z.string(), title: z.string(), rebuildable: z.literal(false),
  version: z.literal(1), template: z.string(), fields: z.record(z.string().min(1), fieldSchema),
  display: z.object({ title: z.string().optional(), summary: z.string().optional(), priority: z.number().optional() }).strict().optional()
}).strict()

/** 加载预检与每次记录变更共用校验；写入时必须在事务内调用，失败不替换现有定义。 */
export function buildDefinedKind(plugin: CorePlugin, source: BlockKind, entityId: string, data: BlockData): BlockKind {
  const definer = plugin.defines!
  const input = normalizeBlock(source, structuredClone(data))
  const result = kindSchema.parse(definer.build(entityId, input))
  if (result.id !== definer.prefix! + entityId || result.plugin !== plugin.id || result.template !== entityId) throw new Error('动态定义的 ID、插件或来源身份与声明不符')
  for (const name of [result.display?.title, result.display?.summary]) {
    if (name === undefined) continue
    const field = result.fields[name]
    if (!field || field.list || !['text', 'longtext'].includes(field.type)) throw new Error('动态定义的呈现字段必须为单值文字')
  }
  return result
}
