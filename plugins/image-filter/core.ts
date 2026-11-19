import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
import { geometry } from './model'
export const plugin: CorePlugin = {
  id: 'image-filter', version: 1, blocks,
  dataLifecycle: { version: 1, retainedEffects: ['仅清理可重建的画幅分类；保留图片元数据、原件和保存视图中的筛选条件。'] },
  systems: [{ id: 'image-filter.geometry', priority: 70, has: ['image'], outputs: ['image-filter.geometry'],
    inputs: ['image.width', 'image.height'],
    async run(_ctx, _id, b) { return { 'image-filter.geometry': geometry(b.image.data.width, b.image.data.height) } }
  }]
}
