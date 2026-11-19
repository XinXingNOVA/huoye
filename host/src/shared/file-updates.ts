import { z } from 'zod'
import { versionRequestId, type ContentVersion } from './space-versions'

export const acceptFileUpdateSchema = z.object({ id: z.string().min(1).max(200), expectedPath: z.string().min(1),
  contentVersion: z.string().uuid(), revision: z.number().int().positive(), requestId: versionRequestId }).strict()
export type AcceptFileUpdate = z.infer<typeof acceptFileUpdateSchema>
export interface FileUpdatePreview {
  id: string; spaceId: string; fileId: string; revision: number; expectedPath: string
  previous: ContentVersion & { reference: string; sample?: string; unavailable?: string }
  current: ContentVersion & { reference: string; sample?: string; unavailable?: string }
}
export interface FileUpdateScan { updated: number; pending: number; errors: { spaceId: string; message: string }[] }
