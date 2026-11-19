import type { SettingsPage } from '../../plugin-api/ui/settings'
import { applicationSettingsPages } from './application-settings-catalog'
import { settingsSections } from './ui-registry'

const librarySections = [
  { id: 'import', title: '导入与空间', keywords: ['导入与空间策略'], description: '默认文件空间、自动收录与新版本策略' },
  { id: 'plugins', title: '启停功能', keywords: ['功能与插件'], description: '管理当前仓库启用的内置与外部插件' },
  { id: 'plugin-presets', title: '方案组合', keywords: ['插件组合预设'], description: '保存与切换常用的插件启用方案' },
  { id: 'development', title: '本地源码开发', keywords: ['插件开发', '源码覆盖', '高级'], description: '从本地源码目录构建并覆盖加载插件' },
  { id: 'maintenance', title: '数据与维护', keywords: ['数据维护'], description: '查看数据库占用、管理 AI 任务与插件数据、清理缓存' }
] satisfies Omit<SettingsPage, 'scope'>[]

export function settingsCatalog(): SettingsPage[] {
  return [
    ...librarySections.map(p => ({ ...p, scope: 'library' as const })),
    ...settingsSections().map(({ id, title, description, keywords, pluginId, pluginTitle, scope }) => ({ id, title, description, keywords, pluginId, pluginTitle, scope: 'library' as const, storage: scope })),
    ...applicationSettingsPages()
  ]
}
