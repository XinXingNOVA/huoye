import { parseInput } from '@resource-manager/plugin-api/operations'
import { updateTagsSchema } from './input'
import type { Command } from '@resource-manager/plugin-api/core/contracts'
export const commands: Record<string, Command> = {
  update(ctx, input) {
    const { ids: rawIds, add, remove } = parseInput(updateTagsSchema, input)
    const ids = [...new Set(rawIds)]
    const live = new Set(ctx.query({ ids }).ids)
    const missing = ids.filter(id => !live.has(id))
    if (missing.length) throw new Error(`[NOT_FOUND] 素材不存在或已在回收站：${missing.join(', ')}`)
    const changed: string[] = [], unchanged: string[] = []
    for (const id of ids) {
      const previous = (ctx.blocksOf(id).tags?.data.values ?? []) as string[]
      const next = [...new Set([...previous.filter(t => !remove.includes(t)), ...add])]
      if (JSON.stringify(previous) === JSON.stringify(next)) { unchanged.push(id); continue }
      if (next.length) ctx.put(id, 'tags', { values: next })
      else ctx.remove(id, 'tags')
      changed.push(id)
    }
    return { label: `更新标签（${changed.length} 项）`, result: { changed, unchanged, added: [...new Set(add)], removed: [...new Set(remove)] } }
  }
}
