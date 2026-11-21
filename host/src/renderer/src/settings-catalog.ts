import { uiText } from '../../shared/i18n/interface-display'
import type { SettingsPage } from '../../plugin-api/ui/settings'
import { applicationSettingsPages } from './application-settings-catalog'
import { settingsSections } from './ui-registry'

const librarySections = [
  { id: 'import', get title() { return uiText("导入与空间") }, keywords: ['导入与空间策略'], get description() { return uiText("默认文件空间、自动收录与新版本策略") } },
  { id: 'plugins', get title() { return uiText("启停功能") }, keywords: ['功能与插件'], get description() { return uiText("管理当前仓库启用的内置与外部插件") } },
  { id: 'plugin-presets', get title() { return uiText("方案组合") }, keywords: ['插件组合预设'], get description() { return uiText("保存与切换常用的插件启用方案") } },
  { id: 'development', get title() { return uiText("本地源码开发") }, keywords: ['插件开发', '源码覆盖', '高级'], get description() { return uiText("从本地源码目录构建并覆盖加载插件") } },
  { id: 'library-appearance', get title() { return uiText("本库外观") }, storage: 'local', keywords: ['一库一风', '主题', '颜色'], get description() { return uiText("跟随应用默认外观或为此库单独设置主题") } },
  { id: 'maintenance', get title() { return uiText("数据与维护") }, keywords: ['数据维护'], get description() { return uiText("查看数据库占用、管理 AI 任务与插件数据、清理缓存") } }
] satisfies Omit<SettingsPage, 'scope'>[]

export function settingsCatalog(): SettingsPage[] {
  return [
    ...librarySections.map(p => ({ ...p, scope: 'library' as const })),
    ...settingsSections().map(({ id, title, category, description, keywords, pluginId, pluginTitle, scope }) => ({ id, title, category, description, keywords, pluginId, pluginTitle, scope: 'library' as const, storage: scope })),
    ...applicationSettingsPages()
  ]
}
