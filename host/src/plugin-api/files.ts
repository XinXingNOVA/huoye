/** 声明 uiFeatures: ["file-edits-v1"]，经 host.core 调用；不在同步 commands 事务里 await。 */
export type { PrepareFileEdit, CommitFileEdit, DiscardFileEdit, FileEditCapabilities, FileEditPreview, FileEditResult } from '../shared/file-edits'
export type { FileUpdatePreview, AcceptFileUpdate } from '../shared/file-updates'
export type { SpaceHistoryInput, SpaceHistoryPage, RestoreVersionInput } from '../shared/space-versions'
