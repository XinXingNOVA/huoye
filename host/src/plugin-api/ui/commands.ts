import type { PluginNeeds } from '../../shared/plugin-plan'
import type { Query } from '../../shared/query'
import type { UiHost } from './contracts'

export interface CommandContext {
  readonly page?: { readonly id: string; readonly type: string; readonly query?: Query }
  readonly ids: readonly string[]
}
/** 宿主标准图标；快捷栏无需用户选图或上传资源。 */
export const QUICK_ACTION_ICONS = ['grid', 'text', 'import', 'command', 'tool', 'search', 'book', 'tag', 'music', 'chat', 'clock', 'layout', 'history', 'folder', 'plus', 'split'] as const
export type QuickActionIcon = typeof QUICK_ACTION_ICONS[number]
export interface CommandContribution extends PluginNeeds {
  /** 插件 ID + '.' 前缀；不与后端 CorePlugin.commands 或 MCP operation 混用。 */
  id: string
  title: string
  category?: string
  keywords?: string[]
  /** 默认 window；page 要求来源页仍存在；selection 还要求原选择完整存在。 */
  context?: 'window' | 'page' | 'selection'
  /** 选择命令可用于含容器的选区。 */
  includeContainers?: boolean
  /** 仅表示已由其他入口实际绑定的快捷键，本声明不注册按键。 */
  accelerator?: string
  danger?: boolean
  /** quick-actions-v1：常用操作栏入口，仅 window 命令；默认 tool 图标、order=100。 */
  quickAction?: { icon?: QuickActionIcon; order?: number }
  /** 同步、轻量、无副作用。不得在此请求数据库或网络。 */
  when?(context: CommandContext): boolean
  /** true 可执行，false 禁用，字符串禁用并说明原因。 */
  enabled?(context: CommandContext): boolean | string
  run(context: CommandContext, host: UiHost): void | Promise<void>
}
export interface CommandItem {
  id: string
  title: string
  category: string
  /** Stable host category, when available. */
  categoryId?: string
  keywords?: readonly string[]
  accelerator?: string
  danger?: boolean
  enabled: boolean
  disabledReason?: string
  pluginId?: string
}
export interface CommandSession {
  readonly context: CommandContext
  /** 首次聚合一次；后续搜索不重复读取仓库，匹配名称、分类、关键词。 */
  list(search?: string): Promise<readonly CommandItem[]>
  /** 明确重新聚合；来源上下文保持。 */
  refresh(): Promise<readonly CommandItem[]>
  /** 执行前复核来源、素材存在性及可用性；异常交给调用界面显示。 */
  execute(id: string): Promise<void>
  /** 取消未完成的读取／执行前检查，不撤销已开始的业务动作。 */
  dispose(): void
}
export interface CommandService {
  /** 必须在命令面板取得焦点之前调用。页面宿主会固定到其页面。 */
  createSession(options?: {
    /** quick-actions-v1：只聚合这些稳定命令 ID，省略时仍聚合完整命令面板。 */
    ids?: readonly string[]
  }): CommandSession
}
