import { z } from 'zod'

const id = z.string().uuid()
export const versionRequestId = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/)
export const stageVersionSchema = z.object({ spaceId: id, source: z.string().min(1), requestId: versionRequestId,
  content: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), name: z.string().min(1) }).strict().optional(),
  target: z.object({ fileId: id, revision: z.number().int().positive() }).strict().optional() }).strict()
export type StageVersionInput = z.infer<typeof stageVersionSchema>
export const commitVersionSchema = z.object({ spaceId: id, draftId: id, previewToken: z.string().regex(/^[a-f0-9]{64}$/), requestId: versionRequestId }).strict()
export type CommitVersionInput = z.infer<typeof commitVersionSchema>
export interface ContentVersion {
  id: string; fileId: string; name: string; hash: string; size: number; createdAt: number; ordinal: number
}
export interface VersionDraft {
  id: string; fileId: string; baseRevision: number | null; contentVersion: string; name: string
  state: 'copying' | 'ready' | 'committed' | 'failed' | 'discarded'; hash: string | null; size: number | null; error: string | null
}
export interface VersionCommit {
  requestId: string; replayed: boolean; spaceId: string; fileId: string; contentVersion: string; revision: number; changeSeq: number
}
export interface SpaceVersionReadiness {
  spaceId: string; storage: 'versioned'; files: number; members: number; readyForWarehouseWrites: boolean
  blockers: string[]; references: 'not-audited'; versionBytes: number
}

export const spaceHistorySchema = z.object({ spaceId: id, fileId: id, offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20), revision: z.number().int().positive().optional() }).strict()
export type SpaceHistoryInput = z.input<typeof spaceHistorySchema>
export interface SpaceHistoryPage {
  fileId: string; revision: number; currentVersion: string; recycled: boolean; total: number; nextOffset?: number
  versions: (ContentVersion & { unavailable?: string })[]; canRestore: boolean; blocked?: string
}
export const restoreVersionSchema = z.object({ spaceId: id, fileId: id, contentVersion: id,
  revision: z.number().int().positive(), requestId: versionRequestId }).strict()
export type RestoreVersionInput = z.infer<typeof restoreVersionSchema>
