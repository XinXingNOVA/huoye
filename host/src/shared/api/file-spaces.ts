import type { SpaceBindingInfo, SpacePage, SpacePageInput } from '../file-spaces'
import type { SpaceMutationInput, SpaceMutationPreviewInput, SpaceMutationPreview, SpaceMutationResult } from '../file-spaces'
import type { FileStorageInfo } from '../file-storage'

/**
 * 经当前仓库身份访问空间事实和原件操作；读取可以包含本库收录关系。
 * 不等于独立空间管理权限，不绕过关联、成员授权和预演校验。
 */
export interface FileSpaceApi {
  listFileSpaces(input?: import('../file-spaces').SpaceListInput): SpaceBindingInfo[]
  listSpaceFiles(input: SpacePageInput): SpacePage
  /** 素材已接纳的原件存储信息，以及空间当前版本和本库权限。 */
  fileStorageInfo(id: string): FileStorageInfo
  spaceFileHistory(input: import('../space-versions').SpaceHistoryInput): import('../space-versions').SpaceHistoryPage
  restoreSpaceVersion(input: import('../space-versions').RestoreVersionInput): Promise<import('../space-versions').VersionCommit>
  previewSpaceMutation(input: SpaceMutationPreviewInput): SpaceMutationPreview
  mutateSpaceFiles(input: SpaceMutationInput): SpaceMutationResult
  cancelSpaceOperation(requestId: string): void
}
