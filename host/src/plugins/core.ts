// 核心专用装配入口；完整校验在按仓库停用列表筛选之前完成。
import { Registry } from '../core/registry'
import { catalogBlocks, catalogEntries } from '../shared/plugin-catalog'
import { validateContributions, validatePlugins } from '../shared/plugin-plan'
import { PLUGINS } from './manifest'
import { entries } from './generated/core'
import { entries as schemas } from './generated/blocks'

validatePlugins(PLUGINS, true)
catalogBlocks(PLUGINS, schemas)
export const corePlugins = catalogEntries(PLUGINS, 'core', entries)
for (const p of corePlugins) {
  const shared = schemas.find((s) => s.id === p.id)?.blocks
  if (shared ? p.blocks !== shared : (p.blocks?.length ?? 0) > 0) throw new Error(`插件 ${p.id} 的 CorePlugin.blocks 必须引用声明入口的同一 blocks 数组`)
}
validateContributions(corePlugins, ['recognizers', 'systems', 'exportSections'], PLUGINS)
new Registry(corePlugins)
