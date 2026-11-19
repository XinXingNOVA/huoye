import type { ComponentType } from 'react'

/** 无仓库也可使用；不持有 CoreClient 或当前仓库选择。 */
export interface ApplicationUiHost {
  settings: import('./settings').SettingsService
  openSettings(target?: import('./settings').SettingsTarget): Promise<boolean>
  service(plugin: string, method: string, input?: unknown): Promise<unknown>
  pickDirectory(): Promise<string | null>
}
/** 打开应用设置的窗口身份，仅用于定位当前仓库。开始页省略此项。 */
export interface ApplicationSettingsProps {
  host: ApplicationUiHost
  windowLibrary?: Readonly<{ libraryId: string; root: string }>
}
export interface ApplicationUiPlugin {
  id: string
  settingsSections: (import('./settings').SettingsMetadata & { id: string; order?: number; Component: ComponentType<ApplicationSettingsProps> })[]
}
