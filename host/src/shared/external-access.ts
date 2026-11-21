import type { CoreMethod } from './rpc'

// 应用服务的类型与主进程运行时入口共用这一份核心方法清单。
const externalCoreMethods = [
  'describeLibrary', 'searchPage', 'readItem', 'readItems', 'facetPage', 'readContent', 'readPreview', 'processingStatus',
  'executeQuery', 'executeOperation', 'listHistory', 'readHistory', 'libraryTask', 'reviewBatch',
  'getImportSettings', 'importFiles', 'listFileSpaces', 'listSpaceFiles', 'adoptSpaceFiles',
  'listSpaceItems', 'referencedDirectorySpaces', 'directoryFilePage', 'prepareDirectoryAdoption', 'commitDirectoryAdoption',
  'externalFileAction', 'previewItemLifecycle', 'applyItemLifecycle', 'previewUnlinkFileSpace'
] as const satisfies readonly CoreMethod[]
export type ExternalCoreMethod = typeof externalCoreMethods[number]
export const isExternalCoreMethod = (method: string): method is ExternalCoreMethod =>
  externalCoreMethods.some(name => name === method)

// 接入权限是本机宿主状态；协议插件不能绕过它直接调用核心。
export type AccessMode = 'off' | 'read' | 'organize' | 'admin'
export type OperationEffect = 'data' | 'structure'

/** 管理权限不包含应用包安装、原件授权或不可恢复清除。 */
export const canOrganize = (mode: AccessMode): boolean => mode === 'organize' || mode === 'admin'
export function accessCapabilities(mode: AccessMode) {
  const read = mode !== 'off', organize = canOrganize(mode), admin = mode === 'admin'
  return {
    read, organize, structure: admin, plugins: admin,
    workbenchSession: read, workbenchPresentation: organize, workbenchConfiguration: admin,
    workbench: admin, // 旧客户端以此字段判断能否编排本库布局。
    reviewRead: read, reviewManage: organize
  }
}
export function operationDenied(mode: AccessMode, effect: OperationEffect | undefined): string | undefined {
  if (!canOrganize(mode)) return '[READ_ONLY] 此仓库只允许读取'
  if (effect !== 'data' && effect !== 'structure') return '[OPERATION_UNCLASSIFIED] 插件尚未声明操作影响类别，请升级插件后重试'
  if (effect === 'structure' && mode !== 'admin') return '[ADMIN_REQUIRED] 修改仓库结构需要管理权限'
}
export interface AccessConnection {
  libraryId: string
  mode: AccessMode
  endpoint: string
  token: string
}
