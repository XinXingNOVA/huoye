import type { BlockKind } from '../../shared/blocks'

/** 文件块：收进库里的原文件。接入时捕获，不可重建；内容类。 */
export const fileBlock: BlockKind = {
  id: 'file',
  plugin: 'file',
  title: '文件',
  rebuildable: false,
  content: true,
  version: 1,
  display: { title: 'name', priority: 100 },
  fields: {
    name: { type: 'text', title: '文件名', index: true, search: true },
    ext: { type: 'text', title: '格式', index: true },
    mime: { type: 'text', title: '类型', index: true },
    size: { type: 'number', title: '大小', index: true, format: 'bytes' },
    hash: { type: 'text', title: 'SHA-256', index: true },
    path: { type: 'text', title: '库内路径', file: true }
  }
}

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [fileBlock]
