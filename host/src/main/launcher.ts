import { installPageLifecycle, cancelWindowClose } from './page-lifecycle'
import { installFullscreenTracking, windowChrome } from './window-options'
// 仓库管理窗口：最近的仓库、新建仓库、打开文件夹（像 Obsidian 的仓库管理）。
// 没有要打开的仓库时（第一次启动、关掉了所有仓库后点程序坞图标）出现。

import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { loadRenderer } from './libraries'

let launcher: BrowserWindow | undefined

export function showLauncher(show = true): BrowserWindow {
  if (launcher && !launcher.isDestroyed()) {
    cancelWindowClose(launcher)
    if (show) launcher.focus()
    return launcher
  }
  const win = new BrowserWindow({
    width: 860,
    height: 560,
    show,
    minWidth: 780,
    minHeight: 540,
    title: app.name,
    backgroundColor: '#1a1b1e',
    ...windowChrome(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.on('page-title-updated', (e) => e.preventDefault())
  installFullscreenTracking(win)
  win.on('closed', () => {
    if (launcher === win) launcher = undefined
  })
  installPageLifecycle(win)
  launcher = win
  loadRenderer(win, 'launcher')
  return win
}

export const launcherWindow = () => launcher && !launcher.isDestroyed() ? launcher : undefined

export function closeLauncher(): void {
  if (launcher && !launcher.isDestroyed()) launcher.close()
}
