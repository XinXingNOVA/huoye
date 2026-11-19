import { z } from 'zod'

// 来源只用于说明调用入口，不代表权限，也不证明调用方是某个 AI。
export const historySourceSchema = z.enum(['application', 'external', 'system'])
export type HistorySource = z.infer<typeof historySourceSchema>
export interface HistoryContext { source?: HistorySource; plugin?: string; operation?: string; requestId?: string; reviewable?: boolean }
const id = z.number().int().positive().safe()
export const historyPageSchema = z.object({ before: id.optional(), limit: z.number().int().min(1).max(100).default(30), requestId: z.string().min(1).max(128).optional() }).strict()
export type HistoryPageInput = z.input<typeof historyPageSchema>
export const historyDetailSchema = z.object({ id, offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict()
export type HistoryDetailInput = z.input<typeof historyDetailSchema>
export const historyGuardSchema = z.object({ session: id, revision: z.number().int().min(0), id }).strict()
export type HistoryGuard = z.infer<typeof historyGuardSchema>
export interface HistoryEntry {
  id: number; at: number; label: string
  state: 'done' | 'undone' | 'discarded'
  source: HistorySource; plugin?: string; operation?: string; requestId?: string
  /** 仍保留的影响记录；永久清除素材后可能减少。 */
  affected: number
  kinds: string[]; kindsTruncated: boolean
}
export interface HistoryPage {
  session: number; revision: number
  entries: HistoryEntry[]; total: number; nextBefore: number | null
  undo: { id: number; label: string } | null
  redo: { id: number; label: string } | null
  /** 可选以兼容旧宿主；bytes 为历史载荷估算，不含 SQLite 页与索引开销。trimmed 仅计本会话按预算移除的操作。 */
  retention?: { limit: number; byteLimit: number; bytes: number; trimmed: number }
}
export interface HistoryDetail {
  session: number; revision: number; entry: HistoryEntry
  entities: { id: string; exists: boolean; trashed: boolean; kinds: string[]; kindsTruncated: boolean }[]
  nextOffset: number | null
}
