import type { PluginNeeds } from '../../shared/plugin-plan'

/** 声明 ui-extension-points-v1。纯校验：undefined 表示有效，文字表示载荷问题；抛错表示校验器故障。 */
export interface UiExtensionPoint {
  id: string
  version: number
  validate(value: unknown): string | undefined
}
export interface UiExtensionContribution extends PluginNeeds {
  id: string
  point: string
  version: number
  order?: number
  /** 可包含组件／函数；不序列化，不在此对象保存页面状态。 */
  value: unknown
}
export interface UiExtension<T = unknown> {
  readonly id: string
  readonly pluginId: string
  readonly point: string
  readonly version: number
  readonly value: T
}
export interface UiExtensionDiagnostic {
  readonly pluginId: string
  readonly id: string
  readonly point: string
  readonly version: number
  readonly phase: 'resolve' | 'validate' | 'render' | 'action'
  readonly message: string
}
/** 当前仓库窗口的静态目录；重载才重装配。泛型须与提供方公开契约一致，不替代载荷校验。 */
export interface UiExtensions {
  list<T = unknown>(point: string, version: number): readonly UiExtension<T>[]
  /** 本次窗口最近 100 个不同问题；订阅只通知诊断变化，不是动态注册。 */
  diagnostics(): readonly UiExtensionDiagnostic[]
  subscribe(listener: () => void): () => void
  /** 捕获同步／异步错误并记录贡献来源，再抛给调用方处理；不替业务执行事务或撤销。 */
  invoke<T, R>(extension: UiExtension<T>, action: (value: T) => R): Promise<Awaited<R>>
  reportFailure(extension: UiExtension, error: unknown, phase: 'render' | 'action'): void
}
