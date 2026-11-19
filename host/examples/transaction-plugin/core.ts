import { z } from 'zod'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'

const createInput = z.object({ title: z.string().trim().min(1).max(200) }).strict()
const idInput = z.object({ id: z.string().min(1).max(200) }).strict()
export const plugin: CorePlugin = {
  id: 'demo-container', version: 1, blocks,
  commands: {
    create(ctx, args) {
      const input = createInput.parse(args), id = ctx.createEntity()
      ctx.put(id, 'demo-container', input)
      return { label: '新建示例容器', result: { id } }
    },
    trash(ctx, args) {
      const { id } = idInput.parse(args)
      if (!ctx.query({ ids: [id], has: ['demo-container'] }).ids.length) throw new Error('容器不存在或已删除')
      ctx.trash([id])
      return { label: '删除示例容器', result: { id } }
    }
  },
  operations: [
    { name: 'demo_container_create', title: '新建示例容器', description: '创建一个可搜索的容器素材，可在应用撤销。', command: 'create', input: createInput },
    { name: 'demo_container_trash', title: '删除示例容器', description: '容器移入回收站，关联成员保留，可在应用撤销。', command: 'trash', input: idInput }
  ],
  ingestMetadata: [{
    id: 'demo-container.join', title: '导入到示例容器', description: '提交时检查目标容器仍存在且未删除，再设置当前素材的 link 关系。',
    input: z.object({ group: z.string().min(1).max(200) }).strict(),
    apply(ctx, input) {
      const group = input.group as string, target = ctx.readEntity(group, ['demo-container'])
      if (!target || target.deleted || !target.blocks['demo-container']) throw new Error('目标不是有效容器')
      if (ctx.blocksOf()['demo-container']) throw new Error('示例容器不能嵌套')
      if (ctx.blocksOf()['demo-container.member']?.data.group === group) return { status: 'unchanged' }
      ctx.put('demo-container.member', { group })
      return { status: 'applied' }
    }
  }]
}
