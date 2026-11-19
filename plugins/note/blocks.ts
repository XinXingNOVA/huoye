import type { BlockKind } from '@resource-manager/plugin-api/blocks'

/** 笔记块：对整个素材的想法。 */
export const noteBlock: BlockKind = {
  id: 'note',
  display: { title: 'text', summary: 'text', priority: 10 },
  plugin: 'note',
  title: '笔记',
  rebuildable: false,
  version: 1,
  fields: {
    text: { type: 'longtext', title: '内容', search: true }
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [noteBlock]
