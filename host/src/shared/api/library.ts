import type { HistoryPageInput, HistoryPage, HistoryDetailInput, HistoryDetail, HistoryGuard, HistorySource } from '../history'
import type { TaskCapacity, TaskLimits, TaskCleanupTarget, TaskCleanupPlan, TaskMarkerUsage } from '../library-task'
import type { DatabaseStorageInfo, DatabaseCompaction } from '../database-maintenance'
import type { BlockData, BlockKind, EntityIdentity, EntityView } from '../blocks'
import type { Cond, FacetItem, FacetOptions, Query, QueryResult, Snippet, TextSearch } from '../query'
import type { PluginAssembly, PluginInfo } from '../plugin-plan'
import type { ExternalBinding } from '../external-plugins'
import type { LibraryDescription, SearchPageRequest, SearchPageResult, ReadItemRequest, ItemDetails, ReadItemsRequest, ReadItemsResult, FacetPageRequest, FacetPage, ReadContentRequest, ContentChunk, ExecuteOperationRequest, OperationResult } from '../automation'
import type { ExecuteQueryRequest, QueryResponse } from '../business-queries'
import type { PurgePreview, PurgeResult } from '../item-lifecycle'

/** 当前仓库的身份、数据、业务调用与装配选择；文件操作另有专门协议。 */
export interface LibraryApi {
  // 仓库信息与插件装配
  info(): { root: string; libraryId: string; capabilities: import('../capability-status').CapabilityStatus[]; unavailable: { plugin: string; reason: string }[]; disabledPlugins: string[]; assembly: PluginAssembly }
  /** 运行时才知道的数据块定义：用户的模板、停用的插件留下的休眠定义。启用的插件用代码定义的，界面自己就有。 */
  kinds(): BlockKind[]
  /** 这个仓库的插件：启用了没有、为什么没有。 */
  plugins(): PluginState[]
  /** 设置这个仓库停用哪些插件（存在仓库里）；重新加载仓库后生效。 */
  setPlugins(disabled: string[]): void
  externalPlugins(): ExternalBinding[]
  setExternalPlugin(binding: ExternalBinding): void
  /** 原子保存内置停用清单及外部绑定的增量；重载后生效。 */
  setPluginSettings(disabled: string[], external: ExternalBinding[]): void

  // 通用读取与业务只读查询
  query(q: Query): QueryResult
  get(ids: string[]): EntityView[]
  /** entity-identities-v1：按 ID 读身份与时间，含已回收项；去重、略过缺失项，按返回的 id 匹配。 */
  getIdentities(ids: string[]): EntityIdentity[]
  /** block-facets-v1：批量统计每个块的身份数（含零值），最多 1000 个；不返回素材列表。 */
  kindCounts(kinds: string[], query?: Query): Record<string, number>
  facet(kind: string, field: string, options?: FacetOptions): FacetItem[]
  /** 搜索命中的那一句（卡片上显示）。找不到的身份不在结果里。 */
  snippets(ids: string[], search: string | TextSearch[]): Record<string, Snippet>
  describeLibrary(): LibraryDescription
  searchPage(input: SearchPageRequest): SearchPageResult
  readItems(input: ReadItemsRequest): ReadItemsResult
  facetPage(input: FacetPageRequest): FacetPage
  readItem(input: ReadItemRequest): ItemDetails
  readContent(input: ReadContentRequest): ContentChunk
  /** read-preview-v1：只读素材代表图／缩略图，以有界的内联 JPEG 返回。 */
  readPreview(input: import('../preview').ReadPreviewInput): import('../preview').PreviewResult
  executeQuery(input: ExecuteQueryRequest): QueryResponse

  // 数据修改、准入与业务操作
  /** 新建一个身份并挂上这些数据块（例如保存视图）。只能是不可重建的数据块。 */
  create(blocks: Record<string, BlockData>): string
  put(id: string, kind: string, data: BlockData): void
  /**
   * 改数据块里的几个字段，在核心进程里合并，连续快速的修改不会互相覆盖。null 表示清空这个字段。
   * 字段都空了就移除整个数据块——模板块除外，空的模板块表示"属于这张表"。
   */
  patch(id: string, kind: string, fields: Record<string, unknown>): void
  remove(id: string, kind: string): void
  /** 给这些身份写上条件：列表字段加入这个值，单值字段设为这个值。条件必须都能写入。 */
  apply(ids: string[], where: Cond[]): void
  /**
   * 放入视图（设计文档 10.7）：先等相关加工做完，再按准入条件检查，通过的写上写入条件。
   * 返回接受的身份，以及被拒绝的身份和第一条不满足的条件。
   */
  admit(ids: string[], query: Query, viewId?: string): { accepted: string[]; rejected: { id: string; reason: string }[] }
  /** 执行插件的命令（一个可撤销的操作），返回命令的结果。 */
  run(plugin: string, command: string, args: Record<string, unknown>): unknown
  /** 预演插件的命令：在事务里跑一遍再回滚，什么也不留下，只返回结果（例如会影响多少项）。 */
  preview(plugin: string, command: string, args: Record<string, unknown>): unknown
  libraryTask(input: import('../library-task').LibraryTaskInput): import('../library-task').LibraryTaskResult
  executeOperation(input: ExecuteOperationRequest): OperationResult

  // 素材生命周期与本次运行的撤销
  /** 应用组合删除所需的只读快照与回执；不发布到外部 MCP。 */
  itemDisposalSnapshot(ids: string[]): import('../item-disposal').ItemDisposalSnapshot
  itemLifecycleReceipt(input: import('../item-lifecycle').ItemLifecycleInput): import('../item-lifecycle').ItemLifecycleResult | undefined
  previewItemLifecycle(input: import('../item-lifecycle').ItemLifecyclePreviewInput): import('../item-lifecycle').ItemLifecyclePreview
  /** source 仅作历史来源说明，默认 application；不是授权参数。 */
  applyItemLifecycle(input: import('../item-lifecycle').ItemLifecycleInput, source?: HistorySource): import('../item-lifecycle').ItemLifecycleResult
  trash(ids: string[]): void
  restore(ids: string[]): void
  /** 彻底删除之前：会删几项、带走几条批注、原件保留数量，哪些不能删、为什么。 */
  purgePreview(ids: string[]): PurgePreview
  /**
   * 彻底删除回收站里的这些身份（设计文档 11.13），撤销不了：原文件保留，仅清理不再引用的派生缓存，
   * 数据和历史里关于它们的记录一起去掉。不在回收站里的、还有素材用着的模板不删。
   */
  purge(ids: string[]): PurgeResult
  /** 撤销这次运行里最近的一个操作，返回它的名称；没有可撤销的返回 null。 */
  undo(expected?: HistoryGuard): string | null
  redo(expected?: HistoryGuard): string | null
  /** 本次核心会话的仓库撤销历史；不包含文件空间物理操作或未保存的编辑草稿。 */
  listHistory(input?: HistoryPageInput): HistoryPage
  readHistory(input: HistoryDetailInput): HistoryDetail
  reviewBatch(input: import('../batch-review').BatchReviewInput, source?: import('../batch-review').ReviewSource): import('../batch-review').ReviewPage | import('../batch-review').ReviewList

  // 仓库数据库维护；仅回收 SQLite 空闲页，不删除当前数据、回执、任务或保留中的撤销记录。
  taskCapacity(limits?: TaskLimits): TaskCapacity
  taskMarkerUsage(): TaskMarkerUsage
  previewTaskCleanup(target: TaskCleanupTarget): TaskCleanupPlan
  cleanTask(target: TaskCleanupTarget, revision: string): TaskCleanupPlan
  databaseStorageInfo(): DatabaseStorageInfo
  compactDatabase(): DatabaseCompaction
  /** 当前仓库的插件数据维护；不卸载包、不修改启停，也不删除文件空间原件。 */
  listPluginData(): import('../plugin-data').PluginDataInfo[]
  previewPluginDataCleanup(input: import('../plugin-data').PluginDataRequest): import('../plugin-data').PluginDataPreview
  cleanupPluginData(input: import('../plugin-data').PluginDataCleanupInput): import('../plugin-data').PluginDataCleanupResult
  /** 数据事务已成功、缓存删除失败时接续；不重复删除数据。 */
  retryPluginDataCleanup(input: { pluginId: string }): import('../plugin-data').PluginDataCleanupResult

  // 可重建内容的加工调度
  /** processing-status-v1：有界读取指定素材／数据块的当前加工结果，不触发加工。 */
  processingStatus(input: import('../processing-status').ProcessingStatusInput): import('../processing-status').ProcessingStatus
  processingSummary(): import('../processing-status').ProcessingSummary
  /** 告诉加工调度当前可见的身份，优先处理。 */
  visible(ids: string[]): void
  /** 清除加工记录，重新生成可重建的数据。 */
  regenerate(ids: string[]): void
  /** 请求按需加工：为这个身份产出某种数据块（例如播放前转码）。返回是否有可用的产出者。 */
  demand(id: string, kind: string): boolean

}

export interface PluginState extends PluginInfo {
  /** 这次是否启用。 */
  enabled: boolean
  /** 没有启用的原因：已停用，或者依赖的插件停用了。 */
  reason?: string
  /** 用户自己停用的（依赖停用而跟着停用的不算）。 */
  chosen: boolean
  /** 启用了，但部分或全部加工缺少外部程序或能力。 */
  unavailable?: string
}
