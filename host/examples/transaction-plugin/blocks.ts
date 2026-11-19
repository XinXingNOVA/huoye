import type { BlockKind } from '@resource-manager/plugin-api/blocks'

export const blocks: BlockKind[] = [
  { id: 'demo-container', plugin: 'demo-container', title: '容器', version: 1, rebuildable: false, content: true,
    display: { title: 'title' }, fields: { title: { type: 'text', title: '名称', search: true, index: true } } },
  { id: 'demo-container.member', plugin: 'demo-container', title: '成员关系', version: 1, rebuildable: false,
    fields: { group: { type: 'ref', ref: 'link', title: '容器', index: true } } }
]
