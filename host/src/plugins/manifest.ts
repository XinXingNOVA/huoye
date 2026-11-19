// 稳定入口；名单由插件目录声明生成，启停规则为两端共用的纯函数。
import { PLUGINS as ALL_PLUGINS } from './generated/manifest'
import { resolvePluginPlan, type PluginInfo, type PluginPlan } from '../shared/plugin-plan'
export { ALL_PLUGINS }
export const PLUGINS = ALL_PLUGINS.filter(p => p.scope !== 'application')
export const APPLICATION_PLUGINS = ALL_PLUGINS.filter(p => p.scope === 'application')
export type { PluginInfo, PluginPlan, PluginAssembly } from '../shared/plugin-plan'

export const pluginTitle = (id: string) => PLUGINS.find((p) => p.id === id)?.title ?? id
export const resolvePlugins = (disabled: Iterable<string>, list: PluginInfo[] = PLUGINS): PluginPlan => resolvePluginPlan(disabled, list)
/** 未登记的插件不会被装配。测试自定义核心插件可直接使用 Registry / Host。 */
export const isEnabled = (plan: PluginPlan, id: string) => plan.enabled.has(id)
