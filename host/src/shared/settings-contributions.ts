import type { SettingsMetadata } from '../plugin-api/ui/settings'

/** 同一份来源与标题回退规则用于应用设置和已启用仓库插件；不加载插件代码。 */
export function collectSettings<T extends { id: string; order?: number } & SettingsMetadata>(plugins: { id: string; settingsSections?: T[] }[], manifest: { id: string; title: string }[]) {
  return plugins.flatMap(p => (p.settingsSections ?? []).map(s => {
    const pluginTitle = manifest.find(m => m.id === p.id)?.title ?? p.id
    return { ...s, title: s.title ?? pluginTitle, pluginId: p.id, pluginTitle }
  })).sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id))
}
export function validateSettingsMetadata(s: SettingsMetadata): void {
  if ((s.title !== undefined && (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 100)) ||
      (s.description !== undefined && (typeof s.description !== 'string' || s.description.length > 1000)) ||
      (s.keywords !== undefined && (!Array.isArray(s.keywords) || s.keywords.length > 50 || s.keywords.some(k => typeof k !== 'string' || !k.trim() || k.length > 100)))) throw new Error('设置名称、说明或关键词无效')
}
