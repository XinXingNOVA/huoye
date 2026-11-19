import type { BlockKind } from '../../shared/blocks'

/** 图片块：宽高等基本信息，从文件读出，可重建。 */
export const imageBlock: BlockKind = {
  id: 'image',
  plugin: 'image',
  title: '图片',
  rebuildable: true,
  version: 1,
  fields: {
    width: { type: 'number', title: '宽', index: true, format: 'px' },
    height: { type: 'number', title: '高', index: true, format: 'px' },
    animated: { type: 'boolean', title: '动图', index: true }
  }
}

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff', 'bmp', 'svg', 'heic', 'heif'])

/** 本插件的全部静态定义，由核心和界面共同登记。 */
export const blocks: BlockKind[] = [imageBlock]
