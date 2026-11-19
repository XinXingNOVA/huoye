import { z } from 'zod'

/** 应用级物理处置与空间记录管理。不是仓库 recycle 授权的扩展。 */
export const disposalPreviewSchema = z.object({
  spaceId: z.string().uuid(),
  action: z.enum(['trash', 'verify', 'archive', 'unarchive', 'clean']),
  files: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict())
    .min(1).max(100).refine(rows => new Set(rows.map(r => r.id)).size === rows.length, '文件不能重复')
}).strict()
export const disposalInputSchema = disposalPreviewSchema.extend({
  previewToken: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/)
}).strict()
export type DisposalSelection = z.infer<typeof disposalPreviewSchema>
export type DisposalInput = z.infer<typeof disposalInputSchema>
export type DisposalAction = DisposalSelection['action']
export interface DisposalPreview {
  action: DisposalAction; previewToken: string; members: number; spaceName: string
  files: { id: string; name: string; versions: number; bytes: number; reason?: string; recoveryPath?: string }[]
}
export interface DisposalResult {
  requestId: string; replayed: boolean; action: DisposalAction
  items: { id: string; name: string; outcome: 'done' | 'failed'; message: string }[]
}
export interface PendingDisposal { requestId: string; action: DisposalAction; total: number; completed: number; running: boolean }
export interface DisposalBridge {
  preview(root: string, input: DisposalSelection): Promise<DisposalPreview>
  execute(root: string, input: DisposalInput): Promise<DisposalResult>
  pending(root: string, spaceId: string): Promise<PendingDisposal[]>
  resume(root: string, spaceId: string, requestId: string): Promise<DisposalResult>
}
