import type { PluginCatalog } from './plugin-presentation'

/** 应用发行策略；不接受分享包自行声明。与用户已经保存的选择分开。 */
export interface PluginDistribution {
  id: string
  title: string
  catalog?: PluginCatalog
  group: 'base' | 'common' | 'recommended' | 'optional' | 'support'
  defaultEnabled: boolean
  origin: 'builtin' | 'bundled'
  scope?: 'application' | 'library'
  legacyBuiltin?: boolean
  /** 应用认领的旧块 ID，仅用于已迁出的内置功能；分享包不能自行声明。 */
  legacyKinds?: string[]
  /** 迁出前已保存的动态定义前缀，只由应用授予。 */
  legacyDefinitionPrefixes?: string[]
}
export function distributionOf(id: string, catalog: PluginDistribution[]) { return catalog.find(p => p.id === id) }
