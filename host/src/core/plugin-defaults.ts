import type { Library } from './library'
import type { PluginInfo } from '../shared/plugin-plan'
import type { PluginDistribution } from '../shared/plugin-distribution'

/** 在交接包和启动加工之前保存选择。推荐值变化不会重新解释已有开关。 */
export function initializePluginDefaults(lib: Library, builtin: PluginInfo[], catalog: PluginDistribution[]) {
  const saved = lib.db.prepare("SELECT value FROM main.config WHERE key = 'pluginSelection'").pluck().get() as string | undefined
  const state = saved ? JSON.parse(saved) as { version: number; known: string[] } : undefined
  if (state && (state.version !== 1 || !Array.isArray(state.known) || state.known.some(id => typeof id !== 'string'))) throw new Error('插件选择登记损坏')
  const fresh = !state && !!lib.db.prepare("SELECT 1 FROM main.meta WHERE key = 'plugin_defaults_pending'").get()
  const raw = lib.db.prepare("SELECT value FROM main.config WHERE key = 'plugins'").pluck().get() as string | undefined
  const disabled = new Set<string>(raw ? JSON.parse(raw).disabled ?? [] : [])
  const known = new Set(state?.known ?? [])
  const policies = catalog.filter(p => p.scope !== 'application')
  for (const p of builtin) {
    if (p.required || known.has(p.id)) continue
    if ((fresh && !policies.find(c => c.id === p.id)?.defaultEnabled) || (state && !known.has(p.id))) disabled.add(p.id)
  }
  // 旧版本曾允许关闭 file：保留此前随其关闭的功能，不因基础模块常驻而自动加工。
  // 此项原有兼容由 Host 在装配时处理。
  const added = [...new Set([...known, ...policies.map(p => p.id), ...builtin.map(p => p.id)])]
  if (!state || added.length !== known.size) {
    lib.db.prepare("INSERT INTO main.config (key,value) VALUES ('plugins',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ disabled: [...disabled] }))
    lib.db.prepare("INSERT INTO main.config (key,value) VALUES ('pluginSelection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ version: 1, known: added }))
  }
  lib.db.prepare("DELETE FROM main.meta WHERE key = 'plugin_defaults_pending'").run()
  return { fresh, legacy: !state && !fresh, known }
}
