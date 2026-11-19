// 当前仓库的异步组合入口；包含仓库数据、空间访问及跨层文件流程。
// 分类在 shared/api 定义，调用名称保持平铺；连接、MessagePort 和权限由宿主管理。
import type { CoreApi, CoreEvents } from '../shared/rpc'
export type { ProcessingStatusInput, ProcessingStatus, ProcessingItemStatus, ProcessingKindStatus, ProcessingSummary } from '../shared/processing-status'
export type { ReadPreviewInput, PreviewResult, PreviewItem } from '../shared/preview'

type Async<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
}

export type CoreClient = Async<CoreApi> & {
  on<K extends keyof CoreEvents>(event: K, fn: (payload: CoreEvents[K]) => void): () => void
}

export type { HistoryPageInput, HistoryPage, HistoryEntry, HistoryDetailInput, HistoryDetail, HistoryGuard, HistorySource } from '../shared/history'
export type { DatabaseStorageInfo, DatabaseCompaction } from '../shared/database-maintenance'

export type { PluginDataInfo, PluginDataRequest, PluginDataPreview, PluginDataCleanupInput, PluginDataCleanupResult } from '../shared/plugin-data'
