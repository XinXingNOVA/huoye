export interface FileStorageInfo {
  /** 空间对本仓库的授权，不等于此文件当前可操作，也不包含 MCP 授权。 */
  canRevise?: boolean
  canRecycle?: boolean
  hasUpdate?: boolean
  /** 存储关系的来源；旧逐文件共享不能冒充接收仓库的文件空间。 */
  storageKind: 'space' | 'legacy-shared' | 'legacy-local'
  shared: boolean
  state: 'available' | 'missing' | 'unavailable'
  path?: string
  storageRoot?: string
  reason?: string
  spaceId?: string
  spaceName?: string
  spaceEmbedded?: boolean
  associationState?: 'active' | 'pending' | 'detaching' | 'detached'
  lifecycle?: 'active' | 'recycled' | 'disposing' | 'disposed'
  fileId?: string
  revision?: number
  contentVersion?: string
  currentContentVersion?: string
  contentOrdinal?: number
  currentOrdinal?: number
  mode?: 'private' | 'shared'
}
