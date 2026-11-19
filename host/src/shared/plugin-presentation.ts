/** 面向使用者的目录信息，与发行策略、权限和运行时扩展点无关。 */
export const pluginCategories = [
  { id: 'files', title: '文件与媒体' },
  { id: 'views', title: '视图与浏览' },
  { id: 'information', title: '信息与标记' },
  { id: 'apps', title: '应用与场景' },
  { id: 'tools', title: '工具与连接' },
  { id: 'other', title: '其他' }
] as const
export type PluginCategory = typeof pluginCategories[number]['id']
export interface PluginCatalog {
  category: PluginCategory
  role?: 'feature' | 'support'
  keywords?: string[]
  /** 在哪里使用；不用于生成或限制实际入口。 */
  usage?: string
}
type ListedPlugin = { id: string; title: string; description: string; catalog?: PluginCatalog; required?: boolean }
/** 旧附带包可用发行目录补充展示；绝不改写已保存的包清单和版本绑定。 */
export function catalogOf(info: Pick<ListedPlugin, 'id' | 'catalog'>, fallback: { id: string; catalog?: PluginCatalog }[] = []): PluginCatalog {
  return info.catalog ?? fallback.find(p => p.id === info.id)?.catalog ?? { category: 'other' }
}
export function catalogGroup(info: Pick<ListedPlugin, 'id' | 'catalog' | 'required'>, fallback: { id: string; catalog?: PluginCatalog }[] = []): string {
  const catalog = catalogOf(info, fallback)
  return info.required ? 'core' : catalog.role === 'support' ? 'support' : catalog.category
}
export function matchesPlugin(info: ListedPlugin, query: string, fallback: { id: string; catalog?: PluginCatalog }[] = []): boolean {
  const catalog = catalogOf(info, fallback)
  const text = [info.id, info.title, info.description, catalog.usage, ...catalog.keywords ?? []].join(' ').toLocaleLowerCase()
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word))
}
