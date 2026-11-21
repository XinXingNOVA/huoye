import type { LibraryApi } from './api/library'
import type { FileSpaceApi } from './api/file-spaces'
import type { FileWorkflowApi } from './api/file-workflows'

// 原有契约入口继续提供相同导出；类型与限制值的定义归各自领域。
export type { IngestSource, IngestInput, ImportInput } from './ingest-input'
export { MAX_IMPORT_BYTES } from './ingest-input'
export type { PluginState } from './api/library'
export type { ExportPreview, ExportRequest, ExportResult, TakeoutPreview, TakeoutResult } from './api/file-workflows'
export type { PurgePreview, PurgeResult } from './item-lifecycle'

/**
 * 当前仓库连接的组合契约，不代表所有方法都只修改仓库。
 * 保留平铺方法名；CoreClient 在 UI 边界统一转换为异步调用。
 */
export interface CoreApi extends LibraryApi, FileSpaceApi, FileWorkflowApi {}

export interface CoreEvents {
  /** 仓库撤销历史在事务提交后变化；失败与命令预演不通知。 */
  historyChanged: Record<string, never>
  reviewsChanged: Record<string, never>
  spaceChanged: { spaceId: string; fileIds?: string[]; sourceKind?: 'directory' }
  fileSpaceChanged: { spaceId: string }
  /** 导出进度。 */
  exporting: { done: number; total: number }
  /** 这些身份的数据块变了。 */
  changed: { ids: string[] }
  /** 查询结果可能变了：身份增删、宽高比变化、可索引的数据变化。 */
  listChanged: Record<string, never>
  /** 加工进度。 */
  progress: { running: number; busy: boolean }
  /** 单个加工的进度（按需加工时显示给用户）。 */
  job: { id: string; system: string; progress: number }
  /** 由数据定义的数据块变了（用户新建或修改了模板）。 */
  kinds: Record<string, never>
}

export type CoreMethod = keyof CoreApi

export interface RpcRequest {
  id: number
  method: CoreMethod
  args: unknown[]
}

export type RpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: string }

export interface RpcEvent<K extends keyof CoreEvents = keyof CoreEvents> {
  event: K
  payload: CoreEvents[K]
}
