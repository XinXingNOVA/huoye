// 业务只读查询；不依赖 MCP，不提供命令、写库或文件访问能力。
import { z } from 'zod'
import type { Blocks } from '../shared/blocks'
import type { Query, FacetItem, FacetOptions } from '../shared/query'
import type { ContentChunk, ItemDetails, ReadContentRequest, ReadItemRequest, SearchPageRequest, SearchPageResult } from '../shared/automation'

export interface QueryPage<T> { items: T[]; total: number; nextCursor: string | null }
export const queryPageSchema = <T extends z.ZodType>(item: T) => z.object({
  items: z.array(item), total: z.number().int().nonnegative(), nextCursor: z.string().nullable()
}).strict()

export interface QueryContext {
  search(input: SearchPageRequest): SearchPageResult
  readItem(input: ReadItemRequest): ItemDetails
  readContent(input: ReadContentRequest): ContentChunk
  /** 结构化副本；单次至多 1 MiB。大正文请用 readContent。 */
  blocksOf(id: string, kinds?: string[]): Blocks
  count(query: Query): number
  /** 无 query 时为全库活跃素材；支持查询范围。未指定 limit 时超过 10000 项报错，不截断。 */
  facet(kind: string, field: string, options?: FacetOptions): FacetItem[]
  /** 小型业务列表统一分页；每次查询最多调用一次。须确定性排序并返回完整 page。 */
  page<T>(items: readonly T[]): QueryPage<T>
}

export interface QueryDefinition {
  /** 插件内名称；宿主发布为 pluginId.name。 */
  name: string
  title: string
  description: string
  input: z.ZodType<Record<string, unknown>>
  output: z.ZodType<Record<string, unknown>>
  /** 是否使用 ctx.page；标量查询不声明，不接受 limit/cursor。 */
  paginated?: boolean
  /** 同步读已有数据；禁止联网、加工、写入或启动异步任务。 */
  run(ctx: QueryContext, args: Record<string, unknown>): Record<string, unknown>
}

export type { ExecuteQueryRequest, QueryDescription, QueryResponse } from '../shared/business-queries'

export type { TitleCandidate } from '../shared/automation'
