import type { BrowserWindowConstructorOptions } from 'electron'

/** Windows 主窗口用主题化标题栏，右上角仍由系统绘制窗口按钮。 */
export function windowChrome(platform = process.platform, primary = true): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
  if (platform === 'win32' && primary) return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1a1b1e', symbolColor: '#ececef', height: 36 },
    autoHideMenuBar: true
  }
  return { titleBarStyle: 'default' }
}

export interface FullscreenTrackableWindow {
  on(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

const trackedFullscreen = new WeakSet<object>()

/** 向窗口页面同步原生全屏状态（macOS 全屏时系统隐藏红绿灯，页面据此收回左侧留白）。 */
export function installFullscreenTracking(win: FullscreenTrackableWindow): void {
  if (trackedFullscreen.has(win)) return
  trackedFullscreen.add(win)
  const emit = (fullscreen: boolean) => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen', fullscreen)
  }
  win.on('enter-full-screen', () => emit(true))
  win.on('leave-full-screen', () => emit(false))
}
