import type { EntityView } from '../../shared/blocks'

/** 快照稳定直到内容变化。刷新失败可保留上一次 view；missing 才表示身份已不存在。 */
export type EntityState =
  | { readonly status: 'idle' | 'loading' | 'missing'; readonly view?: undefined; readonly error?: undefined }
  | { readonly status: 'ready'; readonly view: EntityView; readonly error?: undefined }
  | { readonly status: 'error'; readonly view?: EntityView; readonly error: string }

/** 公共 hooks 所需的只读来源；具体缓存与更新入口不向插件提供。 */
export interface EntitySource {
  getSnapshot(id: string): EntityState
  subscribe(id: string, listener: () => void): () => void
}
