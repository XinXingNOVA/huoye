// UI 与服务共用的 MCP 设置响应；授权枚举归宿主。
import type { AccessMode } from '../../shared/external-access'
export type McpMode = AccessMode
import type { ApplicationAccessSettings } from '../../shared/application-access'
export interface ApplicationMcpSettings extends ApplicationAccessSettings { config: string }
