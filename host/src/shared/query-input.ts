import { z } from 'zod'
const name = z.string().min(1).max(200)
const ids = z.array(name).min(1).max(100)
const condition = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subtree'), kind: name, field: name, value: z.string().min(1).max(200), tree: z.object({ kind: name, key: name, parent: name }).strict() }).strict(),
  z.object({ op: z.literal('in'), kind: name, field: name, values: z.array(z.union([z.string().max(2000), z.number().finite(), z.boolean()])).min(1).max(100) }).strict(),
  z.object({ op: z.literal('eq'), kind: name, field: name, value: z.union([z.string().max(2000), z.number().finite(), z.boolean()]) }).strict(),
  z.object({ op: z.literal('range'), kind: name, field: name, min: z.number().finite().optional(), max: z.number().finite().optional() }).strict().refine(c => (c.min !== undefined || c.max !== undefined) && (c.min === undefined || c.max === undefined || c.min <= c.max), '需要有效的范围上下限'),
  z.object({ op: z.literal('empty'), kind: name, field: name }).strict()
])
export const querySchema = z.object({
  scope: z.enum(['content', 'all', 'trash']).optional(),
  role: z.enum(['material', 'container', 'browse', 'management']).optional(),
  has: z.array(name).max(30).optional(), lacks: z.array(name).max(30).optional(),
  where: z.array(condition).max(30).optional(), ids: ids.optional(),
  text: z.string().max(2000).optional(),
  search: z.array(z.object({ text: z.string().min(1).max(2000), kind: name.optional(), field: name.optional() }).strict()
    .refine(s => !s.field || !!s.kind, '指定字段时必须指定数据块')).max(10).optional(),
  sort: z.union([z.literal('created'), z.object({ kind: name, field: name }).strict()]).optional(),
  dir: z.enum(['asc', 'desc']).optional()
}).strict()

