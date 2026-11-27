/** 可信外部包的仓库级本机服务；不持有数据库、MCP 授权或窗口对象。 */
export type LocalValue = null | boolean | number | string | LocalValue[] | { [key: string]: LocalValue }
export type LocalScope = 'application' | 'library'
export interface LocalSettings {
  get(scope: LocalScope, key: string): LocalValue | undefined
  set(scope: LocalScope, key: string, value: LocalValue): void
  remove(scope: LocalScope, key: string): void
}
export interface LocalSecrets {
  available(): boolean
  has(scope: LocalScope, key: string): boolean
  get(scope: LocalScope, key: string): string | undefined
  set(scope: LocalScope, key: string, value: string): void
  remove(scope: LocalScope, key: string): void
}
export interface LocalServiceContext {
  /** Current library generation's enabled shared runtime, limited to manifest.servicePrograms. */
  resolveProgram(name: string): string | undefined
  library: { id: string; root: string }
  signal: AbortSignal
  onDispose(dispose: () => void | Promise<void>): void
  settings: LocalSettings
  secrets: LocalSecrets
}
export interface ServiceStreamContext {
  signal: AbortSignal
  /** 必须逐段 await；消费完成才继续，宿主不缓存整份业务结果。 */
  emit(value: LocalValue): Promise<void>
}
export interface StreamOptions {
  signal?: AbortSignal
  onData(value: LocalValue): void | Promise<void>
}
export interface LocalServiceInstance {
  compute?(capability: string, params: import('../shared/image-reads').CapabilityValues, signal: AbortSignal): Promise<import('../shared/image-reads').CapabilityValues>
  invoke?(method: string, input: unknown): unknown | Promise<unknown>
  stream?(method: string, input: unknown, context: ServiceStreamContext): Promise<void>
}
export interface LocalServicePlugin {
  id: string
  start(context: LocalServiceContext): LocalServiceInstance | Promise<LocalServiceInstance>
}
