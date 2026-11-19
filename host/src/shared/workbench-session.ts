import { z } from 'zod'
import { querySchema } from './query-input'
import type { Query } from './query'

const id = z.string().min(1).max(200)
export const sessionReadSchema = z.object({ tabId: id.optional(), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(30) }).strict()
export const sessionExpectedSchema = z.object({ sessionId: z.string().uuid(), contextRevision: z.string().max(1000), windowRevision: z.number().int().nonnegative(), tabId: id }).strict()
export const sessionPresentSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/), expected: sessionExpectedSchema,
  target: z.discriminatedUnion('action', [
    z.object({ action: z.literal('reveal'), ids: z.array(id).min(1).max(100) }).strict(),
    z.object({ action: z.literal('open'), title: z.string().min(1).max(200), query: querySchema }).strict(),
    z.object({ action: z.literal('open_review'), batchId: z.string().uuid() }).strict(),
    z.object({ action: z.literal('open_view'), viewId: id }).strict()
  ])
}).strict()
export const getWorkbenchSessionSchema = sessionReadSchema.extend({ libraryId: id })
export const presentWorkbenchSchema = sessionPresentSchema.extend({ libraryId: id })
export type SessionRead = z.input<typeof sessionReadSchema>
export type SessionPresent = z.infer<typeof sessionPresentSchema>
export type SessionRequest = { action: 'read'; input: SessionRead } | { action: 'present'; input: SessionPresent }
export interface SessionWindows {
  revision: number
  focused: string | null
  windows: { id: string; visible: boolean; focused: boolean }[]
}
export interface CollectionSessionSnapshot {
  instanceId: string
  contextVersion: number
  query?: Query
  queryTruncated: boolean
  layout: string
  selectedIds: string[]
  selectedCount: number
  selectionTruncated: boolean
  resultCount: number
  queryVersion: number
  resultVersion: number
  renderedVersion: number | null
  state: 'querying' | 'error' | 'rendering' | 'ready' | 'unsupported'
  error?: string
  renderedIds: string[]
  renderedCount: number
  renderedTruncated: boolean
  highlightedIds: string[]
  reveal?: { token: string; state: 'pending' | 'rendered' }
}
/** 仅页面运行时提供；不进核心、存档或撤销历史。 */
export interface CollectionSessionApi {
  read(): CollectionSessionSnapshot
  reveal(ids: string[]): { token: string }
}
/** 布局在 DOM 提交后回报；不表示图片解码或后台加工已经完成。 */
export interface LayoutSession {
  revision: number
  highlightedIds: readonly string[]
  reveal?: { token: string; id: string }
  onRendered(input: { revision: number; ids: string[]; revealToken?: string }): void
}
