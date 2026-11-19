import { z } from 'zod'

export const updateTagsSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(100),
  add: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  remove: z.array(z.string().trim().min(1).max(200)).max(100).default([])
}).strict().refine(a => a.add.length + a.remove.length > 0, '请指定要添加或移除的标签')
  .refine(a => !a.add.some(t => a.remove.includes(t)), '同一标签不能同时添加和移除')
