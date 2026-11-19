import type { CorePlugin } from '../../plugin-api/core/contracts'
import { blocks } from './blocks'
import { z } from 'zod'
import { querySchema } from '../../shared/query-input'

const saveSchema = z.object({
  id: z.string().min(1).optional(), expectedSeq: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(1).max(200), query: querySchema,
  layout: z.string().min(1).max(200), options: z.record(z.string(), z.unknown()).default({})
}).strict()

export const viewPlugin: CorePlugin = {
  id: 'view',
  version: 1,
  blocks,
  operations: [{ name: 'save_view', effect: 'structure', title: '保存查询视图', command: 'saveView', input: saveSchema,
    description: '创建或更新可复用的查询与浏览布局。新建不传 id；更新必须传 read_item 返回的 view 块 expectedSeq，拒绝覆盖并发修改。query 使用 search_items 的静态查询结构，layout 使用已启用的浏览布局 ID（如 masonry/table），不配置窗口分屏。返回视图 id，可在工作台 collection 页 target.viewId 中引用。' }],
  commands: {
    saveView(ctx, input) {
      const { id, expectedSeq, ...data } = saveSchema.parse(input)
      // 编译查询校验字段能力；空身份集不扫描素材，也不拒绝暂时缺失的定义。
      ctx.query({ ...data.query, ids: [] })
      if (id) {
        const block = ctx.blocksOf(id).view
        if (!block || !ctx.query({ scope: 'all', ids: [id] }).ids.length) throw new Error('视图已删除，请另存为新视图')
        if (expectedSeq !== block.seq) throw new Error('视图已在别处修改，请重新载入规则或另存为新视图')
        ctx.put(id, 'view', { ...block.data, ...data })
        return { label: `更新视图「${data.title}」`, result: { id } }
      }
      const created = ctx.createEntity()
      ctx.put(created, 'view', data)
      return { label: `新建视图「${data.title}」`, result: { id: created } }
    },
    deleteView(ctx, { id }) {
      if (typeof id !== 'string' || !ctx.blocksOf(id).view) throw new Error('视图不存在')
      const title = String(ctx.blocksOf(id).view.data.title)
      ctx.deleteRecord(id)
      return { label: `删除视图「${title}」` }
    }
  }
}

export { viewPlugin as plugin }
