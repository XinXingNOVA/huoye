import type { ExternalBinding, InstalledPackage, PackageRef } from './external-plugins'
export interface UpdateLibrary {
  root: string; id: string; name: string; binding: ExternalBinding
}
export interface PackageUpdatePreview {
  token: string; previous: PackageRef; next: PackageRef
  libraries: UpdateLibrary[]; blockers: string[]
}
export interface PackageUpdateJob extends PackageUpdatePreview {
  phase: 'prepared' | 'switching' | 'removing' | 'complete'
  error?: string
}
/** 仅主进程到仓库核心的管理通道，不是插件 RPC 或 MCP 写入口。 */
export interface PackageUpdateRequest {
  type: 'package-update'; root: string; libraryId: string; previous: PackageRef; next: PackageRef
  binding: ExternalBinding; packages: InstalledPackage[]; action: 'check' | 'replace'
}
