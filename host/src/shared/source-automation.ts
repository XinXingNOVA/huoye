import { z } from 'zod'
import { ingestMetadataSchema } from '../plugin-api/ingest'
import { adoptSpaceSchema, spacePageSchema, spaceListSchema } from './file-spaces'
import { versionRequestId } from './space-versions'

export const sourceListSchema = spaceListSchema.extend({ includeDirectories: z.boolean().optional() })
export const directoryPageSchema = spacePageSchema.pick({ spaceId: true, search: true, collectFilter: true, limit: true }).extend({
  sourceKind: z.literal('directory'), folderId: z.uuid().nullable().optional(), afterId: z.uuid().optional(),
  suffixes: z.array(z.string().regex(/^[\p{L}\p{N}_+-]{1,32}$/u)).max(64).optional()
})
export type DirectoryFileQuery = z.input<typeof directoryPageSchema>
export const sourcePageToolSchema = spacePageSchema.extend({
  scope: spacePageSchema.shape.scope.unwrap().optional(), recordScope: spacePageSchema.shape.recordScope.unwrap().optional(),
  offset: spacePageSchema.shape.offset.unwrap().optional(),
  sourceKind: z.enum(['managed','directory']).optional(), ...directoryPageSchema.pick({ folderId: true, afterId: true, suffixes: true }).shape
})
const selectedFile = z.object({ id: z.uuid(), stamp: z.string().min(1).max(160), metadata: ingestMetadataSchema.optional() }).strict()
export const directoryAdoptSchema = adoptSpaceSchema.extend({
  sourceKind: z.literal('directory'), files: z.array(selectedFile).min(1).max(100).refine(a => new Set(a.map(f => f.id)).size === a.length, '候选文件不能重复')
})
export type DirectoryAdoption = z.infer<typeof directoryAdoptSchema>
export const sourceAdoptToolSchema = adoptSpaceSchema.extend({ sourceKind: z.enum(['managed','directory']).optional(),
  files: z.array(z.union([selectedFile, adoptSpaceSchema.shape.files.element])).min(1).max(100) })
export const sourceCheckSchema = z.object({
  spaceId: z.uuid(), action: z.enum(['start','status','cancel']), requestId: versionRequestId
}).strict()
export type SourceCheckInput = z.infer<typeof sourceCheckSchema>
export interface SourceCheckStatus {
  requestId: string; spaceId: string
  state: 'running' | 'completed' | 'partial' | 'cancelled' | 'failed'
  checked: number; total?: number; failed: number; fileIssues?: number; message?: string
}
export interface DirectoryFileRow {
  id: string; name: string; path: string; folder: boolean; size: number; stamp: string
  collectionState: 'collected' | 'uncollected' | 'trashed'; collected?: string; hasUpdate: boolean
}
export interface DirectoryFilePage { items: DirectoryFileRow[]; nextAfterId?: string; checkedAt: number | null }
