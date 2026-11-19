import { z } from 'zod'
import { queryPageSchema, type QueryContext } from '@resource-manager/plugin-api/queries'
import type { TagGroup } from './blocks'

/**
 * 标签的业务只读查询：把「素材上的标签值」和「侧栏分组记录」解释成调用方要的
 * 目录（组、成员、未分组、素材数量），不暴露管理记录藏在哪。
 * 计数一律走 ctx.facet，和界面侧栏保持同一口径（排除回收站和管理记录）。
 */

const groupItem = z.object({
  id: z.string(),
  title: z.string(),
  tagCount: z.number().int().nonnegative()
}).strict()

const tagItem = z.object({
  tag: z.string(),
  materialCount: z.number().int().nonnegative(),
  groupId: z.string().nullable(),
  groupTitle: z.string().nullable()
}).strict()

/** 分组记录是可选的单例管理记录；没有记录时等同于「没有任何分组」。 */
function groupsOf(ctx: QueryContext): TagGroup[] {
  const found = ctx.search({ query: { scope: 'all', role: 'management', has: ['tag-groups.groups'], dir: 'asc' }, limit: 1 })
  const own = found.items[0]?.id
  if (!own) return []
  const groups = ctx.blocksOf(own, ['tag-groups.groups'])['tag-groups.groups']?.data.groups
  return Array.isArray(groups) ? (groups as TagGroup[]) : []
}

export const queries = [
  {
    name: 'list_groups',
    title: '列出标签分组',
    description: '按侧栏顺序返回分组稳定 ID、名称和组内标签数，并附带未分组标签数 ungroupedCount。tagCount 是分组目录里的标签数（包含当前没有活跃素材的标签）；要成员、要按素材数量排序时用 list_tags。',
    input: z.object({}).strict(),
    output: queryPageSchema(groupItem).extend({ ungroupedCount: z.number().int().nonnegative() }),
    paginated: true,
    run(ctx: QueryContext) {
      const groups = groupsOf(ctx)
      const assigned = new Set(groups.flatMap(group => group.tags))
      const ungroupedCount = ctx.facet('tags', 'values').filter(row => !assigned.has(row.value)).length
      return {
        ...ctx.page(groups.map(group => ({ id: group.id, title: group.title, tagCount: group.tags.length }))),
        ungroupedCount
      }
    }
  },
  {
    name: 'list_tags',
    title: '列出标签目录',
    description: '返回标签名、活跃素材数量与所属分组，按素材数量降序、同数量按标签字典序，适合分页浏览词表。groupId 省略=全部标签，null=未分组，传分组 ID=该组。materialCount 与界面侧栏同一口径，不含回收站和管理记录。',
    input: z.object({
      groupId: z.string().min(1).max(200).nullable().optional(),
      prefix: z.string().max(100).default('')
    }).strict(),
    output: queryPageSchema(tagItem),
    paginated: true,
    run(ctx: QueryContext, args: Record<string, unknown>) {
      const { groupId, prefix } = args as { groupId?: string | null; prefix: string }
      const counts = new Map(ctx.facet('tags', 'values').map(row => [row.value, row.count]))
      const groups = groupsOf(ctx)
      const groupOf = new Map<string, TagGroup>()
      for (const group of groups) for (const tag of group.tags) groupOf.set(tag, group)
      const rows: { tag: string; materialCount: number; groupId: string | null; groupTitle: string | null }[] = []

      if (groupId === undefined) {
        for (const [tag, materialCount] of counts) {
          const group = groupOf.get(tag)
          rows.push({ tag, materialCount, groupId: group?.id ?? null, groupTitle: group?.title ?? null })
        }
        // 分组目录里有、但活跃素材里已经没人用的标签：仍属于词表，计数为 0。
        for (const tag of groupOf.keys()) if (!counts.has(tag)) {
          const group = groupOf.get(tag)!
          rows.push({ tag, materialCount: 0, groupId: group.id, groupTitle: group.title })
        }
      } else if (groupId === null) {
        for (const [tag, materialCount] of counts) if (!groupOf.has(tag)) rows.push({ tag, materialCount, groupId: null, groupTitle: null })
      } else {
        const group = groups.find(item => item.id === groupId)
        if (!group) throw new Error(`[NOT_FOUND] 分组不存在：${groupId}`)
        for (const tag of group.tags) rows.push({ tag, materialCount: counts.get(tag) ?? 0, groupId: group.id, groupTitle: group.title })
      }

      const filtered = prefix ? rows.filter(row => row.tag.startsWith(prefix)) : rows
      filtered.sort((a, b) => b.materialCount - a.materialCount || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
      return { ...ctx.page(filtered) }
    }
  }
]
