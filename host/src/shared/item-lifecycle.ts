import { z } from 'zod'

export const itemSelectionLimit = 1000

export const itemLifecyclePreviewSchema = z.object({
  action: z.enum(['trash', 'restore', 'purge']),
  missingOnly: z.literal(true).optional(),
  primarySpaceId: z.string().uuid().optional(),
  ids: z.array(z.string().min(1).max(200)).min(1).max(itemSelectionLimit).refine(ids => new Set(ids).size === ids.length, '素材不能重复')
}).strict()
export const itemLifecycleSchema = itemLifecyclePreviewSchema.extend({
  previewToken: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/)
}).strict()
export type ItemLifecyclePreviewInput = z.infer<typeof itemLifecyclePreviewSchema>
export type ItemLifecycleInput = z.infer<typeof itemLifecycleSchema>
export interface ItemLifecyclePreview {
  action: ItemLifecycleInput['action']; previewToken: string; selected: number; affected: number
  originals: 'preserved'; undoable: boolean; purge?: PurgePreview
}
export interface ItemLifecycleResult {
  requestId: string; replayed: boolean; action: ItemLifecycleInput['action']; ids: string[]; originals: 'preserved'; purge?: PurgeResult
}

export interface PurgePreview {
  /** 保留的原文件引用数；包含独享／共享及暂不可用原件。 */
  retainedFiles: number
  /** 会彻底删除的项数（选中的，不含跟着一起删的批注）。 */
  items: number
  /** 依附在它们身上、跟着一起删的批注。 */
  locals: number
  /** 不能删的：不在回收站里、还有素材用着的模板。 */
  skipped: { id: string; reason: string }[]
}

export interface PurgeResult {
  /** 彻底删除了的身份，包括跟着一起删的批注（界面据此关掉它们的标签页）。 */
  ids: string[]
  purged: number
  locals: number
  failed: { id: string; reason: string }[]
}
