import type { ComponentType } from 'react'
import type { PluginNeeds } from '../../shared/plugin-plan'
import type { UiHost } from './contracts'

export interface SettingsMetadata { title?: string; description?: string; keywords?: string[] }
export type SettingsCategory = 'general' | 'appearance'
/** scope 只说明存储归属，不决定运行生命周期，也不承诺同步。 */
export interface SettingsSectionContribution extends PluginNeeds, SettingsMetadata {
  /** 外观贡献出现在本库外观；省略时使用独立插件设置入口。 */
  category?: SettingsCategory
  id: string
  order: number
  scope: 'local' | 'library'
  Component: ComponentType<{ host: UiHost }>
}
export interface SettingsTarget { scope?: 'application' | 'library'; section?: string }
export interface SettingsPage extends SettingsMetadata {
  category?: SettingsCategory
  id: string
  title: string
  scope: 'application' | 'library'
  storage?: 'local' | 'library'
  pluginId?: string
  pluginTitle?: string
}
export interface SettingsLeaveIntent {
  reason: 'navigate' | 'close' | 'reload' | 'shutdown'
  target?: Readonly<Required<SettingsTarget>>
}
export interface SettingsGuard {
  /** 只读、同步、无副作用；组件可用 ref 提供最新表单状态。 */
  state(): { dirty?: boolean; busy?: boolean; message?: string }
  /** dirty 时调用。true 表示已保存、已确认放弃，或明确保留草稿后允许离开。 */
  beforeLeave?(intent: SettingsLeaveIntent, signal: AbortSignal): boolean | Promise<boolean>
}
export interface SettingsSnapshot {
  /** 最近成功的导航目标，不表示浮层是否可见；呈现者拥有显隐。 */
  target?: Readonly<Required<SettingsTarget>>
  revision: number
  busy: boolean
  blockedReason?: string
}
export interface SettingsService {
  pages(): readonly SettingsPage[]
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  open(target?: SettingsTarget): Promise<boolean>
  /** 容器关闭、重载、分类切换前必须等待。false 时保留表单，错误也不得关闭。 */
  beforeLeave(intent: SettingsLeaveIntent, signal?: AbortSignal): Promise<boolean>
  /** 同一 ID 只允许一个拥有者；卸载时注销，不在卸载清理里自动保存。 */
  registerGuard(id: string, guard: SettingsGuard): () => void
}
