import { z } from 'zod'

const reviewIdSchema = z.string().uuid()
const offset = z.number().int().min(0).max(10000), limit = z.number().int().min(1).max(50)
const page = { offset: offset.default(0), limit: limit.default(20) }
const title = z.string().trim().min(1).max(120)
const entityIds = z.array(z.string().min(1).max(200)).min(1).max(100)
const requestIds = z.array(z.string().min(8).max(128)).min(1).max(100)
export const batchReviewToolSchema = z.object({
  libraryId: z.string().min(1), action: z.enum(['create', 'list', 'get', 'confirm', 'withdraw']),
  batchId: reviewIdSchema.optional(), ids: entityIds.optional(), title: title.optional(), requestIds: requestIds.optional(), offset: offset.optional(), limit: limit.optional()
}).strict()
export const batchReviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), title, requestIds }).strict(),
  z.object({ action: z.literal('get'), batchId: reviewIdSchema, ...page }).strict(),
  z.object({ action: z.literal('list'), ...page }).strict(),
  z.object({ action: z.literal('confirm'), batchId: reviewIdSchema }).strict(),
  z.object({ action: z.literal('withdraw'), batchId: reviewIdSchema, ids: entityIds.optional() }).strict()
])
export type BatchReviewInput = z.input<typeof batchReviewSchema>
export type ReviewSource = 'application' | 'external'
export interface ReviewSummary {
  id: string; title: string; state: 'pending' | 'confirmed' | 'withdrawn'
  created: number; decidedBy: ReviewSource | null; decidedAt: number | null
  requests: string[]; unchangedRequests: string[]; items: number; changes: number; preserved: number; withdrawnItems: number
}
export interface ReviewChange {
  kind: string; field: string; title: string; member: string
  format?: string; referenceTitles?: Record<string, string>
  before: unknown; after: unknown; preserved: boolean; currentPreview?: unknown
}
export interface ReviewPage {
  batch: ReviewSummary
  items: { id: string; withdrawn: boolean; withdrawnBy?: ReviewSource; withdrawnAt?: number; changes: ReviewChange[] }[]
  nextOffset: number | null
}
export interface ReviewList { batches: ReviewSummary[]; nextOffset: number | null }
