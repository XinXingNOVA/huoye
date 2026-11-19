import type { BlockKind } from '@resource-manager/plugin-api/blocks'
export const nodeKind = 'tag-tree.node'
export const blocks: BlockKind[] = [{
  id: nodeKind, plugin: 'tag-tree', title: '标签层级节点', version: 1, rebuildable: false,
  standalone: true, management: {}, display: { title: 'tag' },
  fields: { tag: { type: 'text', title: '标签', index: true }, parent: { type: 'text', title: '母标签', index: true } },
  validate(data) {
    for (const key of ['tag', 'parent']) if (data[key] !== undefined && (typeof data[key] !== 'string' || !data[key].trim() || data[key] !== data[key].trim() || data[key].length > 200)) throw new Error('标签必须是 1～200 字的非空文字')
    if (!data.tag || data.tag === data.parent) throw new Error('标签不能为空或以自身为母标签')
  }
}]
