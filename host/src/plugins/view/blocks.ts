import type { BlockKind } from '../../shared/blocks'

/**
 * 视图块：保存下来的查询 + 布局（设计文档 10.3）。
 * 视图是素材库里的一个身份：不可重建、非内容类，所以不会出现在"全部"里；
 * 侧栏的视图列表本身就是一个查询（挂有视图块的身份）。
 */
export const viewBlock: BlockKind = {
  id: 'view',
  display: { title: 'title', priority: 0 },
  plugin: 'view',
  title: '视图',
  rebuildable: false,
  standalone: true,
  management: {},
  version: 1,
  fields: {
    title: { type: 'text', title: '名称', index: true },
    /** 查询（shared/query.ts 的 Query）。 */
    query: { type: 'json', title: '查询' },
    /** 布局类型，例如 masonry。 */
    layout: { type: 'text', title: '布局' },
    /** 布局选项，例如卡片大小。 */
    options: { type: 'json', title: '布局选项' }
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [viewBlock]
