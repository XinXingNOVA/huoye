import type { BlockKind } from '@resource-manager/plugin-api/blocks'
export const blocks: BlockKind[] = [{
  id: 'demo-reviewmemo', plugin: 'demo-reviewmemo', title: '复看备忘', version: 1,
  content: true, rebuildable: false, display: { title: 'text', summary: 'text' },
  fields: { text: { type: 'longtext', title: '内容', search: true } }
}]
