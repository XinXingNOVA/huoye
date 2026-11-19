import { z } from 'zod'
import { pluginCategories } from './plugin-presentation.ts'

export const pluginCatalogSchema = z.object({
  category: z.enum(pluginCategories.map(c => c.id)),
  role: z.enum(['feature', 'support']).optional(),
  keywords: z.array(z.string().trim().min(1).max(40)).max(16).refine(a => new Set(a).size === a.length, '关键词不能重复').optional(),
  usage: z.string().trim().min(1).max(500).optional()
}).strict()
