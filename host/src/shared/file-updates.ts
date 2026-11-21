import { z } from 'zod'
import { versionRequestId, type ContentVersion } from './space-versions'

export const acceptFileUpdateSchema = z.object({ id: z.string().min(1).max(200), expectedPath: z.string().min(1),
  contentVersion: z.union([z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)]), revision: z.number().int().positive(), requestId: versionRequestId }).strict()
export type AcceptFileUpdate = z.infer<typeof acceptFileUpdateSchema>
type VersionPreview = Omit<ContentVersion, 'createdAt' | 'ordinal'> & {
  createdAt?: number; ordinal?: number; reference: string; sample?: string; unavailable?: string
}
export interface FileUpdatePreview {
  id: string; spaceId: string; fileId: string; revision: number; expectedPath: string
  previous: VersionPreview
  current: VersionPreview & { ordinal: number }
}
export interface FileUpdateScan { updated: number; pending: number; errors: { spaceId: string; message: string }[] }
