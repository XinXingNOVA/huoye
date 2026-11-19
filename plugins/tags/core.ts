import { ingestMetadata } from './ingest'
import type { CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { blocks } from './blocks'
import { commands } from './lib/commands'
import { updateTagsSchema } from './lib/input'
import { queries } from './queries'

export const tagsPlugin: CorePlugin = {
  id: 'tags',
  version: 1,
  blocks,
  dataLifecycle: { version: 1, disposableRecords: ['tagGroups'], retainedEffects: ['清除基础标签不会删除标签分组、层级关系或保存视图中的筛选条件；这些分别由其他插件和视图管理。'] },
  ingestMetadata,
  commands,
  queries,
  exportSections: [{
    id: 'tags.values', kind: 'tags', fields: ['values'], order: 30,
    render(data) {
      const values = Array.isArray(data.values) ? data.values.map(String) : []
      return { properties: values.length ? [{ field: 'values', label: '标签', key: 'tags', value: values }] : [],
        inline: values.map(value => `#${value}`).join(' ') }
    }
  }],
  operations: [{
    name: 'update_tags', effect: 'data', title: '批量更新标签', command: 'update', input: updateTagsSchema,
    description: '对最多 100 项素材添加／移除具体标签，保留其他标签。整个批次一起成功或失败，可在应用内一次撤销。重复请求必须复用 requestId；新意图使用新的 requestId。不会修改标签分组。'

  }]
}

export { tagsPlugin as plugin }
