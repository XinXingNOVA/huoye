import type { HistorySource } from '../history'
import type { ImportInput } from '../ingest-input'
import type { ImportOptions, ImportReport, ImportScan, ImportSettings, ImportSettingsInput, ImportFilesRequest } from '../import-settings'
import type { AdoptSpaceInput, SpaceUnlinkPreview } from '../file-spaces'
import type { OperationResult } from '../automation'
import type { Query } from '../query'

/**
 * 当前仓库的跨层文件流程：收录、空间关系、发布／接纳、导出。
 * 各阶段可分别提交；本接口不承诺跨库事务或覆盖原件副作用的统一撤销。
 */
export interface FileWorkflowApi {
  // 输入与收录策略
  getImportSettings(): ImportSettings
  setImportSettings(input: ImportSettingsInput): ImportSettings
  importToLibrary(inputs: ImportInput[], options: ImportOptions): ImportReport
  previewViewImport(inputs: ImportInput[], query: Query): Promise<import('../view-import').ViewImportCandidate[]>
  importToView(inputs: ImportInput[], options: import('../view-import').ViewImportOptions): ImportReport
  /** source 仅作历史来源说明，默认 application；不是授权参数。 */
  importFiles(input: ImportFilesRequest, source?: HistorySource): ImportReport
  ingest(inputs: ImportInput[]): string[]
  scanSpaceImports(): ImportScan
  refreshFileSpace(spaceId: string, fileIds?: string[]): void

  // 仓库与空间关联，以及已有文件的收录／接纳
  previewUnlinkFileSpace(spaceId: string): SpaceUnlinkPreview
  previewForgetFileSpace(spaceId: string): import('../file-spaces').SpaceForgetPreview
  linkFileSpace(root: string, expectedId?: string): string
  unlinkFileSpace(id: string): void
  forgetFileSpace(id: string): void
  setDefaultFileSpace(id: string): void
  adoptSpaceFiles(input: AdoptSpaceInput, source?: HistorySource): OperationResult
  previewFileUpdate(id: string): import('../file-updates').FileUpdatePreview
  acceptFileUpdate(input: import('../file-updates').AcceptFileUpdate): { id: string; contentVersion: string; replayed: boolean }

  // 受控编辑、发布及独立副本
  fileEditCapabilities(id: string): import('../file-edits').FileEditCapabilities
  prepareFileEdit(input: import('../file-edits').PrepareFileEdit): Promise<import('../file-edits').FileEditPreview>
  commitFileEdit(input: import('../file-edits').CommitFileEdit): Promise<import('../file-edits').FileEditResult>
  discardFileEdit(input: import('../file-edits').DiscardFileEdit): void
  /** 准备时传 prepare 的 requestId，提交时传 editId。取消不撤销已提交结果。 */
  cancelFileEdit(requestId: string): void
  /** 受信任外部路由；与本地插件的草稿、取消作用域隔离。 */
  externalFileAction(input: import('../file-actions').FileAction): unknown
  makeFileIndependent(id: string, spaceId?: string, requestId?: string): Promise<import('../file-edits').FileEditResult>

  // 导出与记录取回
  /** 导出之前：会写出什么（几个文件、多大），还会带上哪些批注。 */
  exportPreview(ids: string[]): ExportPreview
  /** 导出到 parent 下一个叫 name 的新文件夹（已有同名的就加编号）。titles：界面上的标题。 */
  exportRun(request: ExportRequest): ExportResult
  /** 不依赖格式导出器的记录取回；保留定义、关系与原文件。 */
  takeoutPreview(ids: string[]): TakeoutPreview
  takeoutRun(request: { ids: string[]; parent: string; name: string }): TakeoutResult
  /** 按记录和字段定位原文件；校验文件声明及仓库边界，不能传任意路径。 */
  locateOriginalFile(input: { id: string; kind: string; field: string; index?: number }): string
}

export interface ExportPreview {
  /** 要导出的项数（选中的）。 */
  items: number
  /** 依附在它们身上、跟着一起导出的批注。 */
  locals: number
  /** 每个文件夹会写出几个文件、多大。 */
  folders: { folder: string; count: number; bytes: number }[]
  /** 缺少格式导出器的记录仍会出现在索引中，但正文不会被导出。 */
  unsupported: number
  /** 专用片段失败时保留通用字段并报告。 */
  problems: string[]
}

export interface TakeoutPreview {
  items: number
  related: number
  files: number
  bytes: number
  externalReferences: number
  problems: string[]
}

export interface TakeoutResult {
  dir: string
  items: number
  files: number
  problems: string[]
}

export interface ExportRequest {
  ids: string[]
  titles: Record<string, string>
  parent: string
  name: string
}

export interface ExportResult {
  /** 导出到的文件夹（绝对路径）。 */
  dir: string
  /** 写出的文件数（不含索引）。 */
  written: number
  failed: { title: string; reason: string }[]
}
