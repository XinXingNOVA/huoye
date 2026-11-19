import type { IpcMainInvokeEvent } from 'electron'
import { libraryOf } from './libraries'
import { launcherWindow } from './launcher'

/** 应用设置仅由实际的顶层应用页面发起。 */
export function trustedWindow(event: IpcMainInvokeEvent) {
  const win = libraryOf(event.sender)?.win ?? launcherWindow()
  if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('请在应用窗口操作设置')
  const url = event.senderFrame.url
  if (url === 'about:blank' || (!url.startsWith('file:') && !url.startsWith(process.env.ELECTRON_RENDERER_URL || 'file:'))) throw new Error('页面尚未加载')
  return win
}
