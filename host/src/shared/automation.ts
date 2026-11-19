import { taskIdSchema } from './library-task'
import { z } from 'zod'
import type { IngestMetadataDescription } from '../plugin-api/ingest'
import type { BlockKind } from './blocks'
import type { Snippet } from './query'
import type { QueryDescription, QUERY_LIMITS } from './business-queries'

// 业务输入在核心校验；MCP 只是把同一份声明翻译成工具。
const name = z.string().min(1).max(200)
export { querySchema } from './query-input'
import { querySchema } from './query-input'

export const searchPageSchema = z.object({
  query: querySchema.default({}), limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(2000).optional()
}).strict()
export const readItemSchema = z.object({
  id: name, kinds: z.array(name).max(30).optional(),
  offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(50)
}).strict()
export const inventoryLimits = { ids: 1000, kinds: 16, blockBytes: 8192, pageBytes: 256 * 1024, facetValues: 100, facetValueBytes: 2048 } as const
export const readItemsSchema = z.object({
  ids: z.array(name).min(1).max(inventoryLimits.ids), kinds: z.array(name).min(1).max(inventoryLimits.kinds),
  offset: z.number().int().min(0).max(inventoryLimits.ids).default(0)
}).strict()
export const facetPageSchema = z.object({
  kind: name, field: name, query: querySchema.default({}),
  limit: z.number().int().min(1).max(inventoryLimits.facetValues).default(50), cursor: z.string().max(2000).optional()
}).strict()
export const readContentSchema = z.object({
  id: name, kind: name, field: name,
  page: z.number().int().min(1).max(100000).optional(),
  offset: z.number().int().min(0).max(100000000).default(0),
  limit: z.number().int().min(1).max(12000).default(6000),
  expectedSeq: z.number().int().min(0).optional()
}).strict()
export const executeOperationSchema = z.object({
  taskId: taskIdSchema.optional(), operation: name, requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  args: z.record(z.string(), z.unknown())
}).strict()

export type SearchPageRequest = z.input<typeof searchPageSchema>
export type ReadItemRequest = z.input<typeof readItemSchema>
export type ReadItemsRequest = z.input<typeof readItemsSchema>
export type FacetPageRequest = z.input<typeof facetPageSchema>
type ProjectedBlock = { seq: number; ver: number } & (
  { data: import('./blocks').BlockData } | { omitted: true; bytes: number }
)
export type ProjectedItem = { id: string; state: 'missing' } | {
  id: string; state: 'active' | 'trashed'; blocks: Record<string, ProjectedBlock>
}
export interface ReadItemsResult { items: ProjectedItem[]; nextOffset: number | null }
export type FacetBucket = { count: number } & (
  { value: string | number | boolean } | { value: null; preview: string; bytes: number; sampleId: string }
)
export interface FacetPage {
  matchedItems: number; withValue: number; missingItems: number; values: FacetBucket[]; nextCursor: string | null
}
export type ReadContentRequest = z.input<typeof readContentSchema>
export type ExecuteOperationRequest = z.input<typeof executeOperationSchema>
export interface OperationDescription {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  reviewable?: false
  effect?: import('./external-access').OperationEffect
}
export interface LibraryDescription {
  libraryId: string
  name: string
  kinds: Omit<BlockKind, 'validate'>[]
  operations: OperationDescription[]
  /** 外部接入按当前授权裁剪操作，并说明不可调用原因。 */
  blockedOperations?: { name: string; title: string; reason: string }[]
  ingestMetadata: IngestMetadataDescription[]
  queries: QueryDescription[]
  limits: { search: number; content: number; inventory: typeof inventoryLimits; queries: typeof QUERY_LIMITS }
}
export interface TitleCandidate { kind: string; field: string; text: string; truncated: boolean }
export interface SearchPageResult {
  items: { id: string; title: string; titleCandidates: TitleCandidate[]; kinds: string[]; snippet?: Snippet }[]
  nextCursor: string | null
}
export interface ItemDetails {
  id: string; title: string; titleCandidates: TitleCandidate[]; createdAt: number; deletedAt: number | null
  processing: 'pending' | 'idle'
  failures: Record<string, string>
  fields: { kind: string; field: string; title: string; seq: number; type: string; preview: unknown; truncated: boolean; pages?: number }[]
  nextOffset: number | null
}
export interface ContentChunk {
  id: string; kind: string; field: string; seq: number; format: string
  page?: number; pages?: number; offset: number; total: number; text: string
  next: ReadContentRequest | null
}
export interface OperationResult { requestId: string; replayed: boolean; result: unknown }

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(`[INVALID_INPUT] ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return result.data
}

export const jsonSchema = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema, { io: 'input' })
