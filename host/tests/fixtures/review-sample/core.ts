import { z } from 'zod'
import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'

export const blocks: BlockKind[] = [{
  id: 'review-sample.card', plugin: 'review-sample', version: 1, title: '样片卡', rebuildable: false,
  fields: {
    themes: { title: '题材', type: 'text', list: true },
    related: { title: '参考对象', type: 'ref', ref: 'link' }
  }
}]
const input = z.object({ ids: z.array(z.string()).min(1).max(100), themes: z.array(z.string()), related: z.string() }).strict()
export const plugin: CorePlugin = {
  id: 'review-sample', version: 1, blocks,
  operations: [{ name: 'sample_edit', title: '填写样片卡', description: '填写所选素材的题材与参考对象', command: 'edit', effect: 'data', input }],
  commands: { edit(ctx, args) {
    const { ids, themes, related } = input.parse(args)
    for (const id of ids) ctx.put(id, blocks[0].id, { themes, related })
    return { label: '填写样片卡' }
  } }
}
