import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks, templateKind } from './blocks'
import { commands } from './lib/commands'
import { operations } from './lib/operations'

/** 自定义字段插件：每块模板块定义一种数据块；模板的结构演变是它的命令。 */
export const fieldsPlugin: CorePlugin = {
  id: 'fields',
  version: 1,
  blocks,
  dataLifecycle: { version: 1, disposableRecords: ['template'], retainedEffects: ['表格列配置和保存视图中的字段条件保留；已删除的模板字段可能显示为不可用。'] },
  defines: { kind: 'template', prefix: 'tpl:', build: templateKind },
  commands,
  operations
}

export { fieldsPlugin as plugin }
