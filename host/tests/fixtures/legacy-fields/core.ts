import type { CorePlugin } from '../../../src/plugin-api/core/contracts'
import { blocks, templateKind } from './blocks'
import { commands } from './lib/commands'

/** 自定义字段插件：每块模板块定义一种数据块；模板的结构演变是它的命令。 */
export const fieldsPlugin: CorePlugin = {
  id: 'fields',
  version: 1,
  blocks,
  defines: { kind: 'template', build: templateKind },
  commands
}

export { fieldsPlugin as plugin }
