import type { BlockKind } from '../../../src/shared/blocks'

/** 标签块：一组标签，每个值都进字段索引。 */
export const tagsBlock: BlockKind = {
  id: 'tags',
  plugin: 'tags',
  title: '标签',
  rebuildable: false,
  version: 1,
  fields: {
    values: { type: 'text', title: '标签', list: true, index: true, search: true }
  }
}

/** 标签组织是仓库数据；素材仍然只挂 tags.values。组 ID 只用于稳定定位与本机折叠状态。 */
export interface TagGroup {
  id: string
  title: string
  tags: string[]
}

export const tagGroupsBlock: BlockKind = {
  id: 'tagGroups',
  plugin: 'tags',
  title: '标签分组',
  rebuildable: false,
  standalone: true,
  management: { emptyWhen: 'groups' },
  version: 1,
  fields: { groups: { type: 'json', title: '分组' } },
  validate(data) {
    if (!Array.isArray(data.groups)) throw new Error('标签分组应为列表')
    const ids = new Set<string>(), titles = new Set<string>(), tags = new Set<string>()
    for (const g of data.groups) {
      if (!g || typeof g.id !== 'string' || !g.id.trim() || ids.has(g.id)) throw new Error('分组 ID 为空或重复')
      if (typeof g.title !== 'string' || !g.title.trim() || g.title !== g.title.trim() || g.title === '未分组' || titles.has(g.title)) throw new Error('分组名称为空、重复或使用了“未分组”')
      if (!Array.isArray(g.tags)) throw new Error('分组中的标签应为列表')
      ids.add(g.id)
      titles.add(g.title)
      for (const tag of g.tags) {
        if (typeof tag !== 'string' || !tag.trim() || tags.has(tag)) throw new Error('标签为空或同时属于多个分组')
        tags.add(tag)
      }
    }
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [tagsBlock, tagGroupsBlock]
