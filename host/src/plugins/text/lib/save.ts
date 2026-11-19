import { z } from 'zod'
import type { CommandContext } from '../../../plugin-api/core/contracts'
const input = z.object({ id: z.string().min(1), revision: z.number().int().nonnegative(), text: z.string() }).strict()
/** Command runner 的同步事务中比较并写入，MCP/检查器/撤销的变更不会被旧草稿覆盖。 */
export function saveText(ctx: CommandContext, raw: unknown) {
  const { id, revision, text } = input.parse(raw)
  if (!ctx.query({ ids: [id], scope: 'all' }).ids.length) throw new Error('素材不存在或已在回收站；草稿保留')
  const block = ctx.blocksOf(id).text
  if (!block) throw new Error('文字数据块已移除；草稿保留')
  if (block.seq !== revision) return { label: '编辑文字', result: { accepted: false, current: { text: String(block.data.content ?? ''), revision: block.seq } } }
  if (String(block.data.content ?? '') !== text) ctx.put(id, 'text', { ...block.data, content: text })
  const current = ctx.blocksOf(id).text
  return { label: '编辑文字', result: { accepted: true, current: { text: String(current.data.content ?? ''), revision: current.seq } } }
}
