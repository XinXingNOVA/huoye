import { taskIdSchema, inputPathSchema } from './library-task'
import { z } from 'zod'
import { ingestMetadataSchema } from '../plugin-api/ingest'
import type { SpaceBindingInfo } from './file-spaces'
import type { IngestResult } from '../plugin-api/operations'

export const importOptionsSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  taskId: taskIdSchema.optional(),
  spaceId: z.string().uuid().optional(),
  collect: z.boolean().optional()
}).strict()
export type ImportOptions = z.infer<typeof importOptionsSchema>
export const importSettingsSchema = z.object({
  defaultSpaceId: z.string().uuid(),
  collect: z.boolean(),
  spaces: z.array(z.object({ spaceId: z.string().uuid(), automatic: z.boolean(), updates: z.enum(['manual', 'automatic']).optional() }).strict()).max(100)
}).strict()
export type ImportSettingsInput = z.infer<typeof importSettingsSchema>
export interface ImportSettings extends ImportSettingsInput {
  bindings: (SpaceBindingInfo & { uncollected?: number; pending?: number })[]
}
export interface ImportReport extends IngestResult {
  /** 展开文件夹或跳过隐藏文件时，把结果的 index 映射回原始输入位置。 */
  expandedFrom?: number[]
  spaceId?: string
  collect: boolean
  saved: { index: number; spaceId: string; fileId: string; name: string; outcome: 'saved' | 'existing' }[]
}
export interface ImportScan {
  collected: number
  remaining: number
  updated?: number
  updatesPending?: number
  errors: { spaceId: string; fileId?: string; message: string }[]
}
export const importFilesSchema = importOptionsSchema.extend({
  files: z.array(z.object({
    path: inputPathSchema,
    metadata: ingestMetadataSchema.optional()
  }).strict()).min(1).max(100)
})
export type ImportFilesRequest = z.infer<typeof importFilesSchema>
