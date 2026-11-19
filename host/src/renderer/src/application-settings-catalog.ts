import { APPLICATION_PLUGINS } from '../../plugins/manifest'
import { entries } from '../../plugins/generated/application-ui'
import { validateContributions } from '../../shared/plugin-plan'
import { catalogEntries } from '../../shared/plugin-catalog'
import { collectSettings, validateSettingsMetadata } from '../../shared/settings-contributions'
import type { SettingsPage } from '../../plugin-api/ui/settings'

const plugins = catalogEntries(APPLICATION_PLUGINS, 'ui', entries)
validateContributions(plugins, ['settingsSections'], APPLICATION_PLUGINS)
export const applicationSections = collectSettings(plugins, APPLICATION_PLUGINS)
applicationSections.forEach(validateSettingsMetadata)
export function applicationSettingsPages(): SettingsPage[] {
  const contributed = applicationSections.map(({ id, title, description, keywords, pluginId, pluginTitle }) => ({ id, title, description, keywords, pluginId, pluginTitle }))
  return [
    { id: 'appearance', title: '外观与主题', keywords: ['颜色', '主题'] },
    ...contributed.filter(p => p.id === 'mcp.connection'),
    { id: 'packages', title: '套件与插件包', keywords: ['已安装插件包', '安装', '更新'] },
    { id: 'spaces', title: '文件空间', keywords: ['全局空间', '本机空间'] },
    { id: 'editors', title: '外部编辑器' },
    ...contributed.filter(p => p.id !== 'mcp.connection')
  ].map(p => ({ ...p, scope: 'application', storage: 'local' }))
}
