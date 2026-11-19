import type { BlockKind } from '@resource-manager/plugin-api/blocks'
export const blocks: BlockKind[] = [{
  id: 'rating', plugin: 'rating', title: '评分', version: 1, rebuildable: false,
  validate(data) { if (data.value !== undefined && (!Number.isInteger(data.value) || Number(data.value) < 1 || Number(data.value) > 5)) throw new Error('评分须为 1～5 的整数') },
  fields: { value: { type: 'number', title: '评分', index: true, format: 'rating', min: 1, max: 5 } }
}]
