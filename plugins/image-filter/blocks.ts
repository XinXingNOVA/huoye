import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import { SHAPES } from './model'
export const blocks: BlockKind[] = [{
  id: 'image-filter.geometry', plugin: 'image-filter', title: '图片画幅', version: 1, rebuildable: true,
  display: { inspector: false },
  fields: {
    shape: { type: 'enum', title: '画幅', options: SHAPES, index: true },
    ratio: { type: 'number', title: '宽高比', index: true },
    longSide: { type: 'number', title: '长边', index: true, format: 'px' },
    shortSide: { type: 'number', title: '短边', index: true, format: 'px' }
  }
}]
