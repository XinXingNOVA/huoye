import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'

export const statusPlugin: CorePlugin = {
  id: 'status',
  version: 1,
  blocks,
  dataLifecycle: {
    version: 1,
    disposableRecords: [],
    retainedEffects: ['只摘除素材上的状态属性，素材原件保留；看板列配置与保存视图中的状态筛选条件保留。']
  }
}

export { statusPlugin as plugin }
