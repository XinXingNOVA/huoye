import type { LibraryStatus, StatusSections } from '../shared/library-status'
import { callCore } from './core-client'
import type { OpenLibrary } from './libraries'
import { isWindowReady } from './page-lifecycle'
import { libraryPluginConfiguration } from './plugin-presets'

/** 只看现有会话，不唤窗、不打开仓库、不尝试修复或重载。 */
export async function libraryStatus(lib: OpenLibrary, sections: StatusSections): Promise<LibraryStatus> {
  const core = lib.core
  const result: LibraryStatus = { libraryId: lib.id, core: lib.win.isDestroyed() ? 'closed' : lib.closing ? 'closing' : lib.reloading ? 'reloading' : lib.offline || core.pid === undefined ? 'offline' : 'running' }
  if (sections.includes('workbench')) result.workbench = {
    state: lib.win.isDestroyed() ? 'closed' : !lib.reloading && !lib.closing && isWindowReady(lib.win) ? 'ready' : 'loading',
    visible: !lib.win.isDestroyed() && lib.win.isVisible()
  }
  if (result.core !== 'running') return result
  const [plugins, processing] = await Promise.all([
    sections.includes('plugins') || sections.includes('errors') ? callCore(core, 'plugins') : undefined,
    sections.includes('processing') ? callCore(core, 'processingSummary') : undefined
  ])
  if (lib.core !== core || lib.reloading || lib.closing || lib.offline || lib.win.isDestroyed() || core.pid === undefined) throw new Error('[LIBRARY_CHANGED] 读取状态期间仓库已关闭或重载，请重新查询')
  if (result.workbench?.state === 'ready' && libraryPluginConfiguration.pendingId(lib)) result.workbench.state = 'layout-pending'
  if (processing) result.processing = processing
  if (plugins) {
    const summary = plugins.map(p => ({ id: p.id, enabled: p.enabled,
      ...(p.external ? { version: p.external.version } : {}),
      ...(p.reason ? { reason: p.reason.slice(0, 1000) } : {}), ...(p.unavailable ? { unavailable: p.unavailable.slice(0, 1000) } : {}),
      ...(lib.services?.problem(p.id) ? { serviceError: lib.services.problem(p.id)!.slice(0, 1000) } : {}) }))
    if (sections.includes('plugins')) result.plugins = summary
    if (sections.includes('errors')) result.errors = summary.flatMap(p => {
      const message = p.serviceError ?? p.unavailable ?? plugins.find(v => v.id === p.id)?.problem
      return message ? [{ plugin: p.id, message: message.slice(0, 1000) }] : []
    })
  }
  return result
}
