import { hostLabel, uiText } from '../../shared/i18n/interface-display'
import { APPLICATION_PLUGINS } from '../../plugins/manifest'
import { entries } from '../../plugins/generated/application-ui'
import { validateContributions } from '../../shared/plugin-plan'
import { catalogEntries } from '../../shared/plugin-catalog'
import { collectSettings, validateSettingsMetadata } from '../../shared/settings-contributions'
import type { SettingsPage } from '../../plugin-api/ui/settings'

const plugins = catalogEntries(APPLICATION_PLUGINS, 'ui', entries)
validateContributions(plugins, ['settingsSections'], APPLICATION_PLUGINS)
export function applicationSections() {
  return collectSettings(plugins, APPLICATION_PLUGINS.map(p => ({ id: p.id, title: hostLabel(p.title) })))
}
applicationSections().forEach(validateSettingsMetadata)
export function applicationSettingsPages(): SettingsPage[] {
  const contributed = applicationSections().map(({ id, title, description, keywords, pluginId, pluginTitle }) => ({ id, title, description, keywords, pluginId, pluginTitle }))
  return [
    { id: 'appearance', title: uiText("外观与主题"), keywords: [uiText("颜色"), uiText("主题")] },
    { id: 'language', title: '界面语言 / Language', keywords: ['English', uiText("简体中文"), 'language', uiText("语言")] },
    ...contributed.filter(p => p.id === 'mcp.connection'),
    { id: 'packages', title: uiText("套件与插件包"), keywords: [uiText("已安装插件包"), uiText("安装"), uiText("更新")] },
    { id: 'spaces', title: uiText("文件空间"), keywords: [uiText("全局空间"), uiText("本机空间")] },
    { id: 'editors', title: uiText("外部编辑器") },
    ...contributed.filter(p => p.id !== 'mcp.connection')
  ].map(p => ({ ...p, scope: 'application', storage: 'local' }))
}
