import { z } from 'zod'
import { versionRequestId } from './space-versions'

const target = z.object({ spaceId: z.string().uuid() }).strict()
export const diskCheckSchema = target.extend({ requestId: versionRequestId, deep: z.boolean().default(false) }).strict()
export const diskPageSchema = target.extend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict()
export const diskPreviewSchema = target.extend({ versionId: z.string().uuid(), source: z.string().min(1).optional() }).strict()
export const diskApplySchema = diskPreviewSchema.extend({ token: z.string().regex(/^[a-f0-9]{64}$/), requestId: versionRequestId }).strict()
export type DiskCheckInput = z.input<typeof diskCheckSchema>
export type DiskPageInput = z.input<typeof diskPageSchema>
export type DiskPreviewInput = z.infer<typeof diskPreviewSchema>
export type DiskApplyInput = z.infer<typeof diskApplySchema>
export type DiskState = 'unchanged' | 'modified' | 'missing' | 'unreadable' | 'unstable'
export interface DiskFingerprint { size: number; mtime: number; ctime: number; ino: number; dev: number }
export interface DiskObservation {
  state: DiskState; path: string; fingerprint?: DiskFingerprint; hash?: string; error?: string
}
export interface DiskChange extends DiskObservation {
  versionId: string; fileId: string; name: string; ordinal: number; current: boolean; checkedAt: number
  replacement?: string
}
export interface DiskPage { items: DiskChange[]; total: number; pending: { requestId: string; name: string; versionId: string }[]; nextOffset?: number }
export interface DiskProgress { requestId: string; checked: number; total: number }
export interface DiskCheckResult { checked: number; total: number; cancelled: boolean; fileIssues?: number }
export interface DiskPreview {
  spaceId: string; versionId: string; fileId: string; name: string; ordinal: number; current: boolean
  token: string; action: 'repair' | 'accept'; source: string; size: number; hash: string; previousHash: string
  members: number; blocked?: string
}
export interface DiskApplyResult { requestId: string; replayed: boolean; action: 'repair' | 'accept' | 'abandoned'; contentVersion: string }
export interface SpaceDiskBridge {
  check(root: string, input: DiskCheckInput): Promise<DiskCheckResult>
  page(root: string, input: DiskPageInput): Promise<DiskPage>
  preview(root: string, input: DiskPreviewInput): Promise<DiskPreview>
  apply(root: string, input: DiskApplyInput): Promise<DiskApplyResult>
  resume(root: string, spaceId: string, requestId: string): Promise<DiskApplyResult>
  abandon(root: string, spaceId: string, requestId: string): Promise<void>
  cancel(requestId: string): Promise<void>
  onProgress(cb: (progress: DiskProgress) => void): () => void
}
