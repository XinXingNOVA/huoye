import type { CoreApi } from '../shared/rpc'
import type { AccessConnection, ExternalCoreMethod } from '../shared/external-access'
import type { LocalServiceInstance } from './local-service'

export type ExternalApi = Pick<CoreApi, ExternalCoreMethod>
export type ExternalCaller = <K extends keyof ExternalApi>(method: K, ...args: Parameters<ExternalApi[K]>) => Promise<ReturnType<ExternalApi[K]>>

/** 每个插件、每个打开的仓库各一个实例；不暴露 Electron、数据库或任意 CoreApi。 */
export interface ServiceContext {
  library: { id: string; root: string }
  signal: AbortSignal
  /** 资源取得后立即登记；启动失败、重载、关库也会逆序清理。 */
  onDispose(dispose: () => void | Promise<void>): void
  /** 仅能取得自己 plugin.json 声明的可执行入口。 */
  executable(name: string): { command: string; args: string[]; env: Record<string, string> }
}

export interface ServiceInstance extends LocalServiceInstance {
  /** 仅接受本仓库窗口发起的调用；插件校验自己的 method / input。 */
  invoke?(method: string, input: unknown): unknown | Promise<unknown>
}
export interface ServicePlugin {
  id: string
  start(context: ServiceContext): ServiceInstance | Promise<ServiceInstance>
}

/** 应用服务不随仓库窗口启停；访问各仓库仍由宿主逐次核对授权。 */
export interface ApplicationServiceContext extends Pick<ServiceContext, 'signal' | 'onDispose' | 'executable'> {
  access: {
    /** 仅本机应用设置入口，不得发布为外部工具。 */
    directorySources(libraryId: string): Promise<{ id: string; name: string; state: import('../shared/directory-spaces').DirectoryConnection['state']; sourceKind: 'directory'; browseDirectory: boolean }[]>
    checkSource(libraryId: string, input: import('../shared/source-automation').SourceCheckInput): Promise<import('../shared/source-automation').SourceCheckStatus>
    setSpacePermission(input: import('../shared/application-access').ApplicationSpacePermissionInput): Promise<import('../shared/application-access').ApplicationSpacePermissionResult>
    configFile: string
    publishEndpoint(endpoint: string): void
    settings(input?: import('../shared/application-access').ApplicationAccessChange): import('../shared/application-access').ApplicationAccessSettings
    developmentSources(key: string): Promise<import('../shared/development-access').DevelopmentCatalog>
    setDevelopmentGrant(input: import('../shared/development-access').SetDevelopmentGrant): Promise<import('../shared/application-access').ApplicationAccessSettings>
    development(action: import('../shared/development-access').DevelopmentAction, input: unknown): Promise<unknown>
    /** 仅验证应用凭据；目标仓库由每次调用明确指定并授权。 */
    authorize(credentials: Pick<AccessConnection, 'libraryId' | 'token'>): void
    list(): import('../shared/application-access').LibraryTarget[]
    status(input: import('../shared/library-status').LibraryStatusInput): Promise<import('../shared/library-status').LibraryStatus>
    workbench(libraryId: string, request: import('../shared/workbench-session').SessionRequest): Promise<unknown>
    processing(libraryId: string, input: import('../shared/processing-status').ProcessingWaitInput): Promise<import('../shared/processing-status').ProcessingObservation>
    importFiles(libraryId: string, input: import('../shared/observed-import').ObservedImportInput): Promise<import('../shared/observed-import').ObservedImportReport>
    catalog(input?: import('../shared/ecosystem-catalog').EcosystemCatalogInput): Promise<import('../shared/ecosystem-catalog').EcosystemCatalog>
    localManagement(input: unknown): import('../shared/application-management').ManagementSettings
    manage(action: import('../shared/application-management').ManagementAction, input: unknown): Promise<unknown>
    open(libraryId: string, background?: boolean): Promise<import('../shared/application-access').LibraryTarget>
    previewCreation(input: import('../shared/application-creation').CreationPreviewInput): import('../shared/application-creation').ApplicationCreationPreview
    creationStatus(requestId: string): Promise<import('../shared/application-access').CreateLibraryReceipt>
    resumeCreation(requestId: string): Promise<import('../shared/application-access').CreateLibraryReceipt>
    cancelCreation(requestId: string): Promise<import('../shared/application-access').CreateLibraryReceipt>
    create(input: import('../shared/application-access').CreateLibraryInput): Promise<import('../shared/application-access').CreateLibraryReceipt>
    call<K extends keyof ExternalApi>(libraryId: string, method: K, ...args: Parameters<ExternalApi[K]>): Promise<ReturnType<ExternalApi[K]>>
  }
}
export interface ApplicationServicePlugin {
  id: string
  start(context: ApplicationServiceContext): ServiceInstance | Promise<ServiceInstance>
}
