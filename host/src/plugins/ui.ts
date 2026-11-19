// 界面专用装配入口，不导入任何核心实现。宿主贡献一起校验见 ui-registry。
import { catalogBlocks, catalogEntries } from '../shared/plugin-catalog'
import { validatePlugins } from '../shared/plugin-plan'
import { PLUGINS } from './manifest'
import { entries } from './generated/ui'
import { entries as schemas } from './generated/blocks'

validatePlugins(PLUGINS, true)
export const uiPlugins = catalogEntries(PLUGINS, 'ui', entries)
export const blockKinds = catalogBlocks(PLUGINS, schemas)
