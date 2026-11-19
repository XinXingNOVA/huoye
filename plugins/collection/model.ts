import type { Query } from '@resource-manager/plugin-api/query';

export const groupQuery: Query = { has: ['collection'], sort: { kind: 'collection', field: 'order' }, dir: 'asc' };
export const membersQuery = (group: string): Query => ({
  lacks: ['collection'],
  where: [{ op: 'eq', kind: 'collectionMember', field: 'group', value: group }],
  sort: { kind: 'collectionMember', field: 'order' },
  dir: 'asc'
});
export const multiMembersQuery = (groups: string[]): Query =>
  groups.length === 1
    ? membersQuery(groups[0])
    : {
        lacks: ['collection'],
        where: [{ op: 'in', kind: 'collectionMember', field: 'group', values: groups }],
        sort: { kind: 'collectionMember', field: 'order' },
        dir: 'asc'
      };

export const MAX_LIST = 4000;

export interface Row {
  id: string;
  title: string;
}

export interface Page {
  items: Row[];
  total: number;
  nextCursor: string | null;
}

export interface Summary {
  id: string;
  title: string;
  count: number;
  coverId: string | null;
  coverPath: string | null;
}

export interface TreeNode {
  id: string;
  title: string;
  parent: string | null;
  order: number;
  count: number;
  totalCount: number;
  childCount: number;
  coverId: string | null;
}

export interface TreeData {
  nodes: TreeNode[];
  ungroupedCount: number;
}

/**
 * 规整有效上级引用：上级不存在、不在活跃组集合中、或形成环路时，该节点回退为根层（null）。
 */
export function normalizeParents(rawParents: ReadonlyMap<string, string | null>, activeIds: ReadonlySet<string>): Map<string, string | null> {
  const clean = new Map<string, string | null>();
  for (const id of activeIds) {
    const p = rawParents.get(id);
    clean.set(id, typeof p === 'string' && p !== id && activeIds.has(p) ? p : null);
  }
  for (const id of activeIds) {
    const seen = new Set<string>([id]);
    let cur = clean.get(id) ?? null;
    while (cur) {
      if (seen.has(cur)) {
        clean.set(id, null);
        break;
      }
      seen.add(cur);
      cur = clean.get(cur) ?? null;
    }
  }
  return clean;
}

/** 检查把 id 的上级设为 targetParent 是否会形成环路。 */
export function wouldCycle(parentMap: ReadonlyMap<string, string | null>, id: string, targetParent: string | null): boolean {
  if (!targetParent) return false;
  if (targetParent === id) return true;
  const seen = new Set<string>([id]);
  let cur: string | null = targetParent;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentMap.get(cur) ?? null;
  }
  return false;
}

/** 返回 rootId 自身及全部活跃后代组 ID（广度优先，带防环保护）。 */
export function descendantIds(nodes: readonly { id: string; parent: string | null }[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent) {
      const list = children.get(n.parent) ?? [];
      list.push(n.id);
      children.set(n.parent, list);
    }
  }
  const found = new Set<string>([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
    }
  }
  return [...found];
}

/** 返回从根祖先到 targetId 的完整路径节点数组。 */
export function ancestorChain(nodes: readonly TreeNode[], targetId: string | undefined): TreeNode[] {
  if (!targetId) return [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const chain: TreeNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(targetId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return chain;
}

/** 格式化文件夹完整路径（如 "2026 项目 / 角色设计"）。 */
export function folderPathLabel(nodes: readonly TreeNode[], targetId: string | undefined): string {
  const chain = ancestorChain(nodes, targetId);
  return chain.map(n => n.title).join(' ／ ');
}
