import { z } from 'zod'

export const processingStatusSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(100),
  kinds: z.array(z.string().min(1).max(200)).min(1).max(16)
}).strict()
export const processingWaitSchema = processingStatusSchema.extend({
  waitMs: z.number().int().min(0).max(10000).default(0),
  expectedRevisions: z.record(z.string().max(200), z.string().max(100)).optional()
}).refine(input => !input.expectedRevisions || Object.keys(input.expectedRevisions).every(id => input.ids.includes(id)), '版本凭据只能包含本批素材')
export type ProcessingStatusInput = z.input<typeof processingStatusSchema>
export type ProcessingWaitInput = z.input<typeof processingWaitSchema>
export type ProcessingState = 'ready' | 'empty' | 'skipped' | 'pending' | 'failed' | 'blocked'
export interface ProcessingKindStatus {
  kind: string
  state: ProcessingState
  system?: string
  plugin?: string
  phase?: 'running' | 'queued' | 'dependencies'
  reason?: string
  /** 现存输出的版本；即使有旧输出，state 也可能为 pending/failed。 */
  seq?: number
  updatedAt?: number
}
export interface ProcessingItemStatus {
  id: string
  /** 本次核心会话及原始记录的版本；不随派生产出变化。 */
  revision: string
  state: 'settled' | 'pending' | 'missing' | 'trashed' | 'changed'
  kinds: ProcessingKindStatus[]
}
export interface ProcessingStatus {
  session: string
  items: ProcessingItemStatus[]
}
export interface ProcessingObservation extends ProcessingStatus {
  waitedMs: number
  timedOut: boolean
}
export interface ProcessingSummary {
  running: number
  queued: number
  pendingChecks: number
  scanningSystems: number
  demanded: number
}
