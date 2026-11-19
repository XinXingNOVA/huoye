import { z } from 'zod'
import { parseInput } from '@resource-manager/plugin-api/operations'
import type { CorePlugin, CommandContext } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
export const input = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(100), value: z.number().int().min(1).max(5).nullable() }).strict()
export function setRating(ctx: CommandContext, args: Record<string, unknown>) {
  const parsed = parseInput(input, args), ids = [...new Set(parsed.ids)]
  const available = new Set(ctx.query({ scope: 'content', role: 'material', ids }).ids)
  if (ids.some(id => !available.has(id))) throw new Error('[NOT_FOUND] 部分素材不存在、已回收或不是素材；未修改评分')
  for (const id of ids) {
    if (parsed.value === null) { if (ctx.blocksOf(id).rating) ctx.remove(id, 'rating') }
    else ctx.put(id, 'rating', { ...ctx.blocksOf(id).rating?.data, value: parsed.value })
  }
  return { label: parsed.value === null ? '清除评分' : `评为 ${parsed.value} 星`, result: { ids, value: parsed.value } }
}
export const plugin: CorePlugin = {
  id: 'rating', version: 1, blocks,
  dataLifecycle: { version: 1, disposableRecords: [], retainedEffects: ['只清除评分，保留素材、原件及保存视图中的评分规则。'] },
  commands: { set: setRating },
  operations: [{ name: 'set_rating', effect: 'data', title: '设置评分', command: 'set', input, description: '为 1～100 项素材统一设置 1～5 整数星级；value 为 null 清除评分。整批可撤销；任一素材无效则全部拒绝。' }]
}
