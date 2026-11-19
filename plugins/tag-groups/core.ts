import { z } from 'zod'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
import { commands } from './lib/commands'
import { createGroupSchema, deleteGroupSchema, moveTagSchema, renameGroupSchema } from './lib/input'
import { queries } from './queries'

export const groupsPlugin: CorePlugin = {
  id: 'tag-groups',
  version: 1,
  blocks,
  dataLifecycle: { version: 1, disposableRecords: ['tag-groups.groups'], retainedEffects: ['素材上的基础标签、层级关系及旧版 tagGroups 备份保留；旧备份只在主动导入时使用。', '本机分组折叠状态单独在本库本机数据中重置。'] },
  commands,
  queries,
  operations: [{
    name: 'import_legacy_groups', effect: 'structure', title: '导入旧版分组', command: 'importLegacy', input: z.object({}).strict(),
    description: '仅在没有独立分组记录时，显式复制最早一份旧版 tagGroups；保留旧备份和素材标签，可撤销。清理后不自动恢复旧分组。'
  }, {
    name: 'create_group', effect: 'structure', title: '新建标签分组', command: 'createGroup', input: createGroupSchema,
    description: '新建一个标签分组，可选把某个已有标签直接放进去（会从原分组移走）。组名不能重复，也不能用“未分组”。返回分组 ID，供 move_tag 使用。分组只组织侧栏，不修改素材上的标签。'
  }, {
    name: 'rename_group', effect: 'structure', title: '重命名标签分组', command: 'renameGroup', input: renameGroupSchema,
    description: '按分组 ID 改名；组名不能与其他分组重复，也不能用“未分组”。只改组织方式，不影响素材标签。'
  }, {
    name: 'delete_group', effect: 'structure', title: '删除标签分组', command: 'deleteGroup', input: deleteGroupSchema,
    description: '按分组 ID 删除分组，组内标签回到“未分组”，标签本身和素材不受影响。'
  }, {
    name: 'move_tag', effect: 'structure', title: '移动标签到分组', command: 'moveTag', input: moveTagSchema,
    description: '把一个标签移到指定分组（会从原分组移走）；group 传 null 表示移回“未分组”。只改组织方式，不修改素材上的标签。'
  }]
}

export { groupsPlugin as plugin }
