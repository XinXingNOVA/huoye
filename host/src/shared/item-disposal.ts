import { z } from 'zod'
import type { ItemLifecyclePreview } from './item-lifecycle'
import type { DisposalPreview } from './space-disposal'

export const disposalTaskId = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/)
export const disposalIds = z.array(z.string().min(1).max(200)).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length, '素材不能重复')
export const itemDisposalSelection = z.union([
  z.object({ ids: disposalIds }).strict(), z.object({ taskId: disposalTaskId }).strict()
])
export const itemDisposalExecution = z.object({
  selection: itemDisposalSelection, previewToken: z.string().regex(/^[a-f0-9]{64}$/), requestId: disposalTaskId
}).strict()
export type ItemDisposalSelection = z.infer<typeof itemDisposalSelection>
export type ItemDisposalExecution = z.infer<typeof itemDisposalExecution>
/** 核心只提供仓库事实；物理处置由应用装配，不是 MCP 或插件的写授权。 */
export interface ItemDisposalSnapshot {
  ids: string[]; affected: string[]; identityToken: string; lifecycle: ItemLifecyclePreview
  files: { spaceId: string; fileId: string }[]
  spaces: { id: string; root: string; name: string; mode: 'private' | 'shared'; members: number; otherReferences: number }[]
}
export interface ItemDisposalPreview {
  previewToken: string; selected: number; affected: number; completed: number; blocked: string[]
  spaces: { id: string; name: string; mode: 'private' | 'shared'; members: number; otherReferences: number; files: DisposalPreview['files'] }[]
}
export interface ItemDisposalTask {
  id: string; updatedAt: number; selected: number; originals: number; completed: number
  state: 'pending' | 'complete'; running: boolean; replayed?: boolean
  library: 'pending' | 'done'; message?: string
  files: { spaceId: string; id: string; name: string; outcome: 'done' | 'failed'; message: string }[]
}
export interface ItemDisposalBridge {
  preview(selection: ItemDisposalSelection): Promise<ItemDisposalPreview>
  execute(input: ItemDisposalExecution): Promise<ItemDisposalTask>
  list(): Promise<ItemDisposalTask[]>
}
