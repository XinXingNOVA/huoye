import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { trustedWindow } from './trusted-window'
import { libraryOf, openLibraries } from './libraries'
import { launcherWindow } from './launcher'
import { PluginLocalFiles } from './plugin-local-files'
import { PluginLocalMaintenance } from './plugin-local-maintenance'
import { localScopeSchema, localPluginSchema } from '../shared/plugin-local'
import type { LocalScope } from '../plugin-api/local-service'

let files: PluginLocalFiles | undefined, maintenance: PluginLocalMaintenance | undefined
const storage = () => files ??= new PluginLocalFiles(join(app.getPath('userData'), 'plugin-local'))
const running = (plugin: string, scope: LocalScope, root?: string) => openLibraries().filter(lib => scope === 'application' || lib.root === root).flatMap(lib => {
  if (lib.reloading || !lib.localPlugins) return [`${lib.name} 正在启动或重载，请稍后重试`]
  return lib.localPlugins.has(plugin) ? [`${lib.name} 中插件仍在运行，请先停用并重载或关闭仓库`] : []
})
export const localMaintenance = () => maintenance ??= new PluginLocalMaintenance(storage(), join(app.getPath('userData'), 'plugin-local-cleanup'), running)
export function registerPluginLocalIpc() {
  const root = (event: Electron.IpcMainInvokeEvent, scope: unknown) => {
    trustedWindow(event); localScopeSchema.parse(scope)
    const lib = libraryOf(event.sender)
    if (scope === 'library' && (!lib || lib.reloading || lib.offline)) throw new Error('当前仓库尚未就绪')
    return lib?.root
  }
  ipcMain.handle('plugin-local:list', (event, scope) => localMaintenance().list(scope, root(event, scope)))
  ipcMain.handle('plugin-local:preview', (event, input) => localMaintenance().preview(input, root(event, input?.scope)))
  ipcMain.handle('plugin-local:clean', (event, input) => localMaintenance().clean(input, root(event, input?.scope)))
  ipcMain.handle('plugin-local:retry', (event, input) => localMaintenance().retry(localPluginSchema.parse(input?.pluginId), input.scope, root(event, input?.scope)))
  ipcMain.handle('plugin-local:state', (event, plugin, scope, action, key, value) => {
    const path = root(event, scope), lib = libraryOf(event.sender)
    localPluginSchema.parse(plugin)
    if (!lib || lib.offline || lib.reloading || !lib.localPlugins?.has(plugin)) throw new Error('[PLUGIN_UNAVAILABLE] 只允许当前仓库运行中的插件访问界面状态')
    const result = storage().state(plugin, scope, path, action, key, value)
    if (action !== 'get') {
      const targets = openLibraries().filter(l => scope === 'application' || l.root === path).map(l => l.win)
      if (scope === 'application' && launcherWindow()) targets.push(launcherWindow()!)
      for (const win of targets) if (!win.isDestroyed()) win.webContents.send('plugin-local:changed', { pluginId: plugin, scope, key })
    }
    return result
  })
}
