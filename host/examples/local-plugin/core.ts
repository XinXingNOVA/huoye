import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { parseInput } from '@resource-manager/plugin-api/operations'
import { z } from 'zod'
import { blocks } from './blocks'
const input = z.object({ id: z.string().min(1), text: z.string().min(1).max(2000) }).strict()
export const plugin: CorePlugin = {
  id: 'demo-reviewmemo', version: 1, blocks,
  commands: {
    update(ctx, args) {
      const { id, text } = parseInput(input, args)
      ctx.put(id, 'demo-reviewmemo', { text })
      return { label: '编辑复看备忘', result: { id } }
    }
  },
  operations: [{ effect: 'data', name: 'demo_update_reviewmemo', title: '编辑复看备忘', description: '修改指定备忘的内容', command: 'update', input }]
}
