import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { trustedWindow } from './trusted-window'
import { uiText } from './language'
import { inspectRuntime } from '../platform/runtime-package'
import { SharedRuntimes } from '../platform/shared-runtimes'

let store: SharedRuntimes | undefined
export function localRuntimes() {
  if (!store) {
    store = new SharedRuntimes(app.getPath('userData'))
    app.once('quit', () => store?.close())
  }
  return store
}
export function notifyRuntimes() {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('providers:changed')
}
export function registerRuntimeSettings() {
  ipcMain.handle('runtimes:list', event => { trustedWindow(event); return localRuntimes().list() })
  ipcMain.handle('runtimes:install', async event => {
    const win = trustedWindow(event)
    const pick = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Huoye Runtime', extensions: ['hyruntime'] }] })
    if (pick.canceled || !pick.filePaths.length) return
    const path = pick.filePaths[0]
    const { manifest, digest, bytes } = await inspectRuntime(path)
    const response = await dialog.showMessageBox(win, { type: 'question', title: uiText('安装共享运行包'), message: uiText('信任并安装此本机程序包？'),
      detail: [manifest.id + ' ' + manifest.version, manifest.target, manifest.programs.join(', '), (bytes / 1048576).toFixed(1) + ' MiB', 'SHA-256: ' + digest].join('\n'),
      buttons: [uiText('取消'), uiText('安装')], cancelId: 0, defaultId: 0 })
    if (response.response !== 1) return
    await localRuntimes().install(path, digest)
    notifyRuntimes()
  })
  ipcMain.handle('runtimes:enable', (event, digest, enabled) => { trustedWindow(event); localRuntimes().setEnabled(digest, enabled); notifyRuntimes() })
  ipcMain.handle('runtimes:remove', async (event, digest) => { trustedWindow(event); await localRuntimes().remove(digest); notifyRuntimes() })
}
