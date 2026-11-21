import { z } from 'zod'
import { ingestMetadataSchema } from '../plugin-api/ingest'

export type SpaceMode = 'private' | 'shared'
export interface SpaceInfo {
  id: string; name: string; root: string; mode: SpaceMode; versioned?: boolean; revision: number; members: number
}
export interface SpaceCounts {
  active: number; recycled: number; records: number; archived: number
  /** 当前仓库的 active 文件关系；outdated 是 collected 的子集。 */
  uncollected?: number; collected?: number; trashed?: number; outdated?: number
}
export const spaceListSchema = z.object({ includeCounts: z.boolean().optional() }).strict()
export type SpaceListInput = z.infer<typeof spaceListSchema>
export interface SpaceBindingInfo {
  counts?: SpaceCounts
  id: string; root: string; name: string; embedded: boolean; default: boolean
  state: 'active' | 'pending' | 'detaching' | 'detached'; mode?: SpaceMode; versioned?: boolean; canRevise?: boolean; canRecycle?: boolean; revision?: number; members?: number; error?: string
}
export interface SpaceCandidate {
  /** 不透明、绑定具体版本的只读引用；读取时仍重新检查空间关联。 */
  reference?: string
  collectionState?: 'uncollected' | 'collected' | 'trashed'
  hasUpdate?: boolean
  id: string; name: string; size: number; hash: string; revision: number
  contentVersion?: string; adoptedVersion?: string; updateError?: string
  state: 'available' | 'unavailable'; collected?: string; trashed?: boolean; error?: string
  lifecycle?: 'active' | 'recycled' | 'disposing' | 'disposed'; recycledAt?: number
  archivedAt?: number; cleanedAt?: number; disposalError?: string
}
export interface SpacePage { counts?: SpaceCounts; snapshot?: string; items: SpaceCandidate[]; total: number; version: number; nextOffset?: number }
export const spacePageSchema = z.object({
  spaceId: z.string().uuid(), scope: z.enum(['active', 'recycled', 'records']).default('active'),
  recordScope: z.enum(['current', 'archived', 'all']).default('current'),
  search: z.string().max(256).optional(),
  collectFilter: z.enum(['all', 'uncollected', 'outdated', 'collected', 'trashed']).optional(),
  includeCounts: z.boolean().optional(), snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50),
  version: z.number().int().optional()
}).strict()
export type SpacePageInput = z.input<typeof spacePageSchema>
export const adoptSpaceSchema = z.object({ spaceId: z.string().uuid(), requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  files: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive(), metadata: ingestMetadataSchema.optional() }).strict()).min(1).max(100)
}).strict()
export type AdoptSpaceInput = z.infer<typeof adoptSpaceSchema>
export const spaceMutationPreviewSchema = adoptSpaceSchema.pick({ spaceId: true }).extend({
  action: z.enum(['recycle', 'restore']),
  files: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict()).min(1).max(100)
    .refine(files => new Set(files.map(f => f.id)).size === files.length, '文件不能重复')
}).strict()
export const spaceMutationSchema = spaceMutationPreviewSchema.extend({ version: z.number().int().positive(), requestId: adoptSpaceSchema.shape.requestId }).strict()
export type SpaceMutationInput = z.infer<typeof spaceMutationSchema>
export type SpaceMutationPreviewInput = z.infer<typeof spaceMutationPreviewSchema>
export interface SpaceReferences {
  scope: 'current-library' | 'unchecked'; active: number; trashed: number; ids: string[]; truncated: boolean
}
export interface SpaceMutationPreview {
  space: SpaceInfo; action: SpaceMutationInput['action']; version: number; blocked?: string
  files: { id: string; name: string; revision: number; eligible: boolean; reason?: string }[]
  references: SpaceReferences
}
export interface SpaceMutationResult {
  requestId: string; replayed: boolean; spaceId: string; action: SpaceMutationInput['action']
  items: { id: string; revision: number; outcome: 'changed' | 'unchanged' }[]
}
export interface SpaceUnlinkPreview { spaceId: string; canUnlink: boolean; reason?: string; references: SpaceReferences }
export interface SpaceForgetPreview { spaceId: string; name: string; canForget: boolean; reason?: string; references: SpaceReferences }
export interface SpaceBridge {
  directories: import('./directory-spaces').DirectorySpaceBridge
  disk: import('./space-disk').SpaceDiskBridge
  disposal: import('./space-disposal').DisposalBridge
  cancelOperation(requestId: string): Promise<void>
  history(root: string, input: import('./space-versions').SpaceHistoryInput): Promise<import('./space-versions').SpaceHistoryPage>
  restoreVersion(root: string, input: import('./space-versions').RestoreVersionInput): Promise<import('./space-versions').VersionCommit>
  setVersionPermission(root: string, spaceId: string, libraryId: string, permission: 'revise' | 'recycle', enabled: boolean, revision: number): ReturnType<SpaceBridge['versionPermissions']>
  versionPermissions(root: string, spaceId: string): Promise<{ revision: number; members: { id: string; name: string; revise: boolean; recycle: boolean }[] }>

  versionReadiness(root: string, spaceId: string): Promise<import('./space-versions').SpaceVersionReadiness>
  files(root: string, input: SpacePageInput): Promise<SpacePage>
  preview(root: string, input: SpaceMutationPreviewInput): Promise<SpaceMutationPreview>
  mutate(root: string, input: SpaceMutationInput): Promise<SpaceMutationResult>
  add(root: string, paths: string[]): Promise<{ added: number; errors: string[] }>
  list(): Promise<SpaceInfo[]>
  pick(): Promise<SpaceInfo | null>
  create(parent: string, name: string, mode: SpaceMode): Promise<SpaceInfo>
  mode(root: string, mode: SpaceMode, revision: number): Promise<SpaceInfo>
}
