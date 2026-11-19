import type { PluginUiState } from '../../plugin-api/ui/local-state'
import type { LocalScope } from '../../plugin-api/local-service'
/** 身份来自命名空间句柄，路径由主进程决定；可信插件模型，不是代码沙箱。 */
export const pluginLocalState = (pluginId: string, scope: LocalScope = 'library'): PluginUiState => ({
  get: key => window.bridge.pluginLocal.state(pluginId, scope, 'get', key),
  set: async (key, value) => { await window.bridge.pluginLocal.state(pluginId, scope, 'set', key, value) },
  remove: async key => { await window.bridge.pluginLocal.state(pluginId, scope, 'remove', key) },
  importOnce: (key, value) => window.bridge.pluginLocal.state(pluginId, scope, 'importOnce', key, value),
  onChanged: listener => window.bridge.pluginLocal.onChanged(event => { if (event.pluginId === pluginId && event.scope === scope) listener(event.key) })
})
