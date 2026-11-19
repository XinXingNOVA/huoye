import { z } from 'zod'
import { libraryNameSchema } from './library-name'
import { creationPluginsSchema, startingPresetSchema, type CreationPreview } from './library-creation'

export const creationRequestSchema = z.object({ requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/) }).strict()
export const creationPreviewSchema = z.object({
  name: libraryNameSchema, preset: startingPresetSchema.optional(), plugins: creationPluginsSchema.optional(),
  background: z.boolean().default(true)
}).strict().refine(v => !(v.preset && v.plugins), '起始方案与明确插件组合只能选择一种')
export const createLibrarySchema = creationPreviewSchema.safeExtend({
  requestId: creationRequestSchema.shape.requestId, previewRevision: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict()
export type CreationPreviewInput = z.input<typeof creationPreviewSchema>
export type CreateLibraryInput = z.input<typeof createLibrarySchema>
export interface ApplicationCreationPreview extends CreationPreview {
  root: string; name: string; mode: 'read' | 'organize' | 'admin'; background: boolean
}
export type CreationPhase = 'planned' | 'claimed' | 'initialized' | 'assembled'
export interface CreationRuntime {
  core: 'stopped' | 'running'
  workbench: 'closed' | 'loading' | 'ready' | 'layout-pending'
  visible: boolean
}
export interface CreateLibraryReceipt {
  requestId: string; libraryId: string; root: string; name: string; replayed: boolean
  taskId?: string; state: 'pending' | 'completed' | 'cancelled'; phase?: CreationPhase
  running: boolean; error?: string; runtime?: CreationRuntime
}
