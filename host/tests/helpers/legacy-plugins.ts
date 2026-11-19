// 旧库与业务单测的显式组合；生产启动只经真实安装包加载状态/看板/笔记/来源/标签/表格/字段/批注。
// 安装包迁移回归仅用此组合准备旧库，验证阶段使用生产清单和真实包。
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'
import type { PluginInfo } from '../../src/shared/plugin-plan'

import { plugin as annotate } from '../fixtures/legacy-annotate/core'
import { plugin as fields } from '../fixtures/legacy-fields/core'
import { plugin as tags } from '../fixtures/legacy-tags/core'
import { plugin as note } from '../fixtures/legacy-note-source/note-core'
import { plugin as source } from '../fixtures/legacy-note-source/source-core'

// 冻结迁包前的持久契约，不能跟随新包导入，否则会掩盖不兼容结构变更。
const status: CorePlugin = { id: 'status', version: 1, blocks: [{
  id: 'status', plugin: 'status', title: '状态', rebuildable: false, version: 1,
  fields: { value: { type: 'enum', title: '状态', options: ['待处理', '进行中', '已完成', '搁置'], index: true } }
}] }
export const legacyCorePlugins = [...corePlugins, status, note, source, tags, fields, annotate]
export const legacyManifest: PluginInfo[] = [...PLUGINS,
  { id: 'annotate', title: '批注', description: '迁包前的批注', requires: ['preview', 'note'], optional: ['image','video','text','pdf'] },
  { id: 'fields', title: '自定义字段', description: '迁包前的自定义字段', optional: ['table'] },
  { id: 'tags', title: '标签', description: '迁包前的标签' },
  { id: 'table', title: '表格', description: '迁包前的表格' },
  { id: 'note', title: '笔记', description: '迁包前的笔记' },
  { id: 'source', title: '来源', description: '迁包前的来源' },
  { id: 'status', title: '状态', description: '迁包前的状态插件' },
  { id: 'kanban', title: '看板', description: '迁包前的看板插件' }
]
