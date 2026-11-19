import type { Cond } from '@resource-manager/plugin-api/query'
export interface TagNode { id: string; tag: string; parent?: string }
export const treeRelation = { kind: 'tag-tree.node', key: 'tag', parent: 'parent' }
export const branchCondition = (tag: string): Cond => ({ op: 'subtree', kind: 'tags', field: 'values', value: tag, tree: treeRelation })
export function descendants(nodes: readonly TagNode[], tag: string): Set<string> {
  const found = new Set([tag]), children = new Map<string, string[]>()
  for (const n of nodes) if (n.parent) children.set(n.parent, [...children.get(n.parent) ?? [], n.tag])
  const queue = [tag]
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) if (!found.has(child)) { found.add(child); queue.push(child) }
  return found
}
