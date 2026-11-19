import { z } from 'zod';
import { queryPageSchema, type QueryContext, type QueryDefinition } from '@resource-manager/plugin-api/queries';
import type { Query } from '@resource-manager/plugin-api/query';
import {
  descendantIds,
  groupQuery,
  MAX_LIST,
  membersQuery,
  multiMembersQuery,
  normalizeParents,
  type Row,
  type TreeNode
} from './model';

const candidate = z.object({ kind: z.string(), field: z.string(), text: z.string(), truncated: z.boolean() }).strict();
type Titles = Record<string, z.infer<typeof candidate>[]>;
const pageOutput = queryPageSchema(z.object({ id: z.string(), title: z.string() }).strict()).extend({
  titleCandidates: z.record(z.string(), z.array(candidate))
});

function finish(ctx: QueryContext, rows: Row[], titles: Titles) {
  const page = ctx.page(rows);
  return { ...page, titleCandidates: Object.fromEntries(page.items.map(row => [row.id, titles[row.id] ?? []])) };
}

const id = z.string().min(1).max(200);

/** 当前业务查询为有界列表；超过上限明确报错，不截断成完整结果。 */
function scan(ctx: QueryContext, query: Query, budget: { calls: number }, titles?: Titles): Row[] {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    if (++budget.calls > 88)
      throw new Error('[COLLECTION_LIMIT] 本次列表过大，请缩小搜索范围；V1 不支持此规模的聚合');
    const page = ctx.search({ query, limit: 50, ...(cursor ? { cursor } : {}) });
    if (titles) for (const item of page.items) titles[item.id] = item.titleCandidates;
    rows.push(...page.items.map(({ id, title }) => ({ id, title })));
    if (rows.length > MAX_LIST)
      throw new Error(`[COLLECTION_LIMIT] V1 列表最多 ${MAX_LIST} 项，请缩小搜索范围`);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

function requireGroup(ctx: QueryContext, id: string) {
  if (!ctx.search({ query: { ids: [id], has: ['collection'] }, limit: 1 }).items.length)
    throw new Error('[NOT_FOUND] 组不存在或已在回收站');
  return ctx.blocksOf(id, ['collection']).collection.data;
}

function activeFolderTree(ctx: QueryContext, budget: { calls: number }) {
  const groupRows = scan(ctx, groupQuery, budget);
  const activeIds = new Set(groupRows.map(r => r.id));
  const rawParents = new Map<string, string | null>();
  const metaMap = new Map<string, { title: string; order: number; cover: string | null }>();
  for (const row of groupRows) {
    const data = ctx.blocksOf(row.id, ['collection']).collection?.data ?? {};
    rawParents.set(row.id, typeof data.parent === 'string' ? data.parent : null);
    metaMap.set(row.id, {
      title: String(data.title ?? row.title ?? '未命名组'),
      order: typeof data.order === 'number' ? data.order : 0,
      cover: typeof data.cover === 'string' ? data.cover : null
    });
  }
  const cleanParents = normalizeParents(rawParents, activeIds);
  return { groupRows, activeIds, cleanParents, metaMap };
}

const treeNodeSchema = z.object({
  id,
  title: z.string(),
  parent: id.nullable(),
  order: z.number(),
  count: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative(),
  coverId: id.nullable()
}).strict();

export const queries: QueryDefinition[] = [
  {
    name: 'list',
    title: '列出组',
    description: '按组顺序列出活跃组，支持组名搜索；分页。每张组卡的成员数与有效封面用 collection.summary 读取。hideEmpty:true 隐藏空组，默认保留；titleCandidates 按当前页 ID 给出名称来源。V1 最多4000组。',
    input: z.object({ text: z.string().max(200).default(''), hideEmpty: z.boolean().default(false) }).strict(),
    output: pageOutput,
    paginated: true,
    run(ctx, args) {
      const titles: Titles = {}, budget = { calls: 0 };
      let rows = scan(
        ctx,
        { ...groupQuery, ...(args.text ? { search: [{ kind: 'collection', field: 'title', text: args.text as string }] } : {}) },
        budget,
        titles
      );
      if (args.hideEmpty) {
        const occupied = new Set(ctx.facet('collectionMember', 'group').map(value => value.value));
        rows = rows.filter(row => occupied.has(row.id));
      }
      return finish(ctx, rows, titles);
    }
  },
  {
    name: 'members',
    title: '读取组成员',
    description: 'group 为组 ID；null 表示有效未分组（包括目标已删除或不存在）。includeSubfolders:true 时递归包含所有活跃子文件夹的成员。排除组、回收站和管理记录；支持全文搜索和分页。ids 可限定最多100项素材，空数组返回空结果；不传表示全库范围。titleCandidates 按当前页 ID 给出名称来源。V1最多4000结果，过大明确报错。',
    input: z.object({
      group: id.nullable(),
      text: z.string().max(200).default(''),
      ids: z.array(id).max(100).optional(),
      includeSubfolders: z.boolean().default(false)
    }).strict(),
    output: pageOutput,
    paginated: true,
    run(ctx, args) {
      const budget = { calls: 0 }, text = args.text as string, titles: Titles = {};
      const ids = args.ids as string[] | undefined, scope = ids ? { ids: [...new Set(ids)] } : {};
      if (args.group) {
        requireGroup(ctx, args.group as string);
        if (ids?.length === 0) return finish(ctx, [], titles);
        if (args.includeSubfolders) {
          const { groupRows, cleanParents } = activeFolderTree(ctx, budget);
          const treePairs = groupRows.map(r => ({ id: r.id, parent: cleanParents.get(r.id) ?? null }));
          const targets = descendantIds(treePairs, args.group as string);
          return finish(
            ctx,
            scan(ctx, { ...multiMembersQuery(targets), ...scope, ...(text ? { text } : {}) }, budget, titles),
            titles
          );
        }
        return finish(ctx, scan(ctx, { ...membersQuery(args.group as string), ...scope, ...(text ? { text } : {}) }, budget, titles), titles);
      }
      if (ids?.length === 0) return finish(ctx, [], titles);
      const valid = new Set(scan(ctx, groupQuery, budget).map(r => r.id));
      const invalid = ctx.facet('collectionMember', 'group').filter(r => !valid.has(r.value));
      const base: Query = { ...scope, lacks: ['collection'], dir: 'asc', ...(text ? { text } : {}) };
      const found = scan(ctx, { ...base, where: [{ op: 'empty', kind: 'collectionMember', field: 'group' }] }, budget, titles);
      for (const r of invalid)
        found.push(...scan(ctx, { ...base, where: [{ op: 'eq', kind: 'collectionMember', field: 'group', value: r.value }] }, budget, titles));
      if (found.length > MAX_LIST)
        throw new Error('[COLLECTION_LIMIT] 未分组结果超过4000项，请缩小搜索范围');
      return finish(ctx, found.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), titles);
    }
  },
  {
    name: 'summary',
    title: '组概况',
    description: '返回有效成员数、有效封面素材 ID 与已有缩略图相对路径（可能为 null）。手选封面失效时使用排序后的首个活跃成员。',
    input: z.object({ id }).strict(),
    output: z.object({ id, title: z.string(), count: z.number().int().nonnegative(), coverId: id.nullable(), coverPath: z.string().nullable() }).strict(),
    run(ctx, args) {
      const id = args.id as string, data = requireGroup(ctx, id), q = membersQuery(id), count = ctx.count(q);
      const explicit = typeof data.cover === 'string' ? ctx.search({ query: { ...q, ids: [data.cover] }, limit: 1 }).items[0]?.id : undefined;
      const coverId = explicit ?? ctx.search({ query: q, limit: 1 }).items[0]?.id ?? null;
      const thumb = coverId ? ctx.blocksOf(coverId, ['thumb']).thumb : undefined;
      return { id, title: String(data.title ?? '未命名组'), count, coverId, coverPath: typeof thumb?.data.path === 'string' ? thumb.data.path : null };
    }
  },
  {
    name: 'tree',
    title: '读取文件夹目录树',
    description: '返回全部活跃文件夹的层级结构（上级 parent、直接成员数 count、递归含子文件夹总数 totalCount、子文件夹数 childCount）以及有效未归档素材数 ungroupedCount。',
    input: z.object({ text: z.string().max(200).default('') }).strict(),
    output: z.object({
      nodes: z.array(treeNodeSchema),
      ungroupedCount: z.number().int().nonnegative()
    }).strict(),
    paginated: false,
    run(ctx, args) {
      const budget = { calls: 0 };
      const { groupRows, activeIds, cleanParents, metaMap } = activeFolderTree(ctx, budget);
      const facets = ctx.facet('collectionMember', 'group');
      const directCounts = new Map(facets.map(f => [f.value, f.count]));
      const emptyCount = ctx.count({ lacks: ['collection'], where: [{ op: 'empty', kind: 'collectionMember', field: 'group' }] });
      const invalidCount = facets.filter(f => !activeIds.has(f.value)).reduce((sum, f) => sum + f.count, 0);
      const ungroupedCount = emptyCount + invalidCount;

      const childrenMap = new Map<string, string[]>();
      for (const row of groupRows) {
        const parent = cleanParents.get(row.id) ?? null;
        if (parent) {
          const list = childrenMap.get(parent) ?? [];
          list.push(row.id);
          childrenMap.set(parent, list);
        }
      }

      const totalMemo = new Map<string, number>();
      const computeTotal = (folderId: string, visiting = new Set<string>()): number => {
        if (totalMemo.has(folderId)) return totalMemo.get(folderId)!;
        if (visiting.has(folderId)) return directCounts.get(folderId) ?? 0;
        visiting.add(folderId);
        let total = directCounts.get(folderId) ?? 0;
        for (const childId of childrenMap.get(folderId) ?? []) {
          total += computeTotal(childId, visiting);
        }
        visiting.delete(folderId);
        totalMemo.set(folderId, total);
        return total;
      };

      let nodes: TreeNode[] = groupRows.map((row, idx) => {
        const meta = metaMap.get(row.id)!;
        const children = childrenMap.get(row.id) ?? [];
        const count = directCounts.get(row.id) ?? 0;
        return {
          id: row.id,
          title: meta.title,
          parent: cleanParents.get(row.id) ?? null,
          order: meta.order || idx + 1,
          count,
          totalCount: computeTotal(row.id),
          childCount: children.length,
          coverId: meta.cover
        };
      });

      const keyword = (args.text as string).trim().toLowerCase();
      if (keyword) {
        const keep = new Set<string>();
        const byId = new Map(nodes.map(n => [n.id, n]));
        for (const n of nodes) {
          if (n.title.toLowerCase().includes(keyword)) {
            let cur: TreeNode | undefined = n;
            while (cur && !keep.has(cur.id)) {
              keep.add(cur.id);
              cur = cur.parent ? byId.get(cur.parent) : undefined;
            }
          }
        }
        nodes = nodes.filter(n => keep.has(n.id));
      }

      return { nodes, ungroupedCount };
    }
  }
];
