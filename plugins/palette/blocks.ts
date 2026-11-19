import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import { FAMILIES, FAMILY_KIND } from './lib/color-families'
/** 色板块：主要颜色及占比。 */
export const paletteBlock: BlockKind = {
  id: 'palette',
  plugin: 'palette',
  title: '色板',
  rebuildable: true,
  version: 1,
  fields: {
    colors: { type: 'color', title: '颜色', list: true },
    weights: { type: 'number', title: '占比', list: true }
  }
}

/** 单独派生色系索引：升级时复用旧色板，不为新增筛选重跑图像采样。 */
export const familyBlock: BlockKind = {
  id: FAMILY_KIND, plugin: 'palette', title: '色系', rebuildable: true, version: 1,
  display: { inspector: false },
  fields: { values: { type: 'enum', title: '色系', list: true, options: FAMILIES.map(f => f.name), index: true } }
}
export const blocks = [paletteBlock, familyBlock]
