/** 原地目录的浏览记录。浏览项属于空间，收录后才有仓库素材身份。 */
export interface DirectorySpace {
  id: string
  name: string
  root: string
}

export type DirectoryConnection = DirectorySpace & { state: 'active' | 'detached' | 'confirm' | 'missing' }
export interface VerificationIssues { total: number; examples: { path: string; reason: string }[] }
export interface DirectoryScanResult {
  checked: number; failed: number; firstIssue?: string; cancelled: boolean; fileIssues: VerificationIssues
}

export interface DirectoryEntry {
  collected?: string
  collectionState?: 'collected' | 'uncollected' | 'trashed'
  hasUpdate?: boolean
  id: string
  name: string
  folder: boolean
  size: number
  stamp: string
}

export const directoryPageSize = 100

export interface DirectoryPage {
  items: DirectoryEntry[]
  total: number
  offset: number
  fileIssues: VerificationIssues
  missingCount: number
  checkedAt: number | null
  issue?: string
}

export interface DirectoryVerification { hash: string; revision: number }
export interface DirectoryUpdatesPage { items: { id: string; path: string; revision: number }[]; total: number; offset: number }
export interface MissingDirectoryFiles { items: { id: string; path: string; size: number }[]; total: number; offset: number }

export interface DirectorySpaceBridge {
  maintenance: DirectoryMaintenanceBridge
  onChanged(listener: (spaceId: string, entriesChanged: boolean) => void): () => void
  refreshTree(spaceId: string, retryOnly?: boolean): Promise<DirectoryScanResult>
  relocate(spaceId: string): Promise<{ sameRoot: boolean; matched: number } | null>
  stopTree(spaceId: string): Promise<void>
  verify(spaceId: string, fileId: string, stamp: string): Promise<DirectoryVerification>
  missing(spaceId: string, offset: number): Promise<MissingDirectoryFiles>
  list(): Promise<DirectorySpace[]>
  connections(): Promise<DirectoryConnection[]>
  pick(expectedSpaceId?: string): Promise<DirectorySpace | null>
  unlink(spaceId: string, expected: { active: number; trashed: number }): Promise<void>
  page(spaceId: string, folderId: string | null, offset: number, refresh: boolean): Promise<DirectoryPage>
  preview(spaceId: string, fileId: string, stamp: string): Promise<string>
}

export const directoryImage = (name: string) => /\.(?:png|jpe?g|webp|gif|avif)$/i.test(name)

export interface DirectoryCollectionPreview {
  token: string
  matched: number
  existing: number
  pending: number
  examples: string[]
}
export interface DirectoryCollectionResult {
  created: number
  skipped: number
  failed: number
  problems: string[]
}

export interface DirectoryCatalogInfo {
  id: string; name: string; root?: string; bytes: number; entries: number; missing: number
  status: 'online' | 'offline' | 'replaced' | 'unreadable' | 'retiring'
  members: { id: string; root: string; available: boolean }[]
  error?: string
}
export interface MissingCleanupPreview {
  cutoff: number; count: number; token: string; examples: string[]
}
export interface DirectoryMaintenanceBridge {
  list(): Promise<DirectoryCatalogInfo[]>
  forget(id: string): Promise<void>
  removeMember(id: string, member: { id: string; root: string }): Promise<void>
  previewMissing(id: string, days: number): Promise<MissingCleanupPreview>
  cleanMissing(id: string, cutoff: number, token: string): Promise<number>
}
