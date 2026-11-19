import { z } from 'zod'
import type { Command } from '../../../plugin-api/core/contracts'
import { parseInput } from '../../../plugin-api/operations'
import { siteOf } from '../../../plugin-api/urls'

export const createTextSchema = z.object({
  content: z.string().min(1).max(32000).refine(s => !!s.trim(), '正文不能为空'),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  source: z.object({
    url: z.string().trim().min(1).max(2048).refine(url => !!siteOf(url), '来源应为 HTTP 或 HTTPS 网页地址'),
    title: z.string().trim().max(200).optional()
  }).strict().optional()
}).strict()

export const createText: Command = (ctx, args) => {
  const { content, tags, source } = parseInput(createTextSchema, args)
  for (const kind of [...(tags?.length ? ['tags'] : []), ...(source ? ['source'] : [])]) {
    const def = ctx.kind(kind)
    if (!def || def.dormant) throw new Error(`[UNAVAILABLE_PLUGIN] ${kind} 插件未启用，无法保存相应字段`)
  }
  const id = ctx.createEntity()
  ctx.put(id, 'text', { content })
  if (tags?.length) ctx.put(id, 'tags', { values: [...new Set(tags)] })
  if (source) ctx.put(id, 'source', { ...source, site: siteOf(source.url)! })
  return { label: '新建文字', result: { id } }
}
