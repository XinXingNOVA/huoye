import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'

type Reason = 'shutdown' | 'reload'
interface State {
  ready: boolean
  recovery(): boolean
  prepared: boolean
  closeAttempt: number
  pending?: { id: string; promise: Promise<void>; resolve(): void; reject(error: Error): void }
}
const states = new WeakMap<WebContents, State>()

/** 只协调页面收尾；核心／服务的停止仍由仓库生命周期负责。 */
export function installPageLifecycle(win: BrowserWindow, recovery: () => boolean = () => false): void {
  const state: State = { ready: false, prepared: false, closeAttempt: 0, recovery }
  states.set(win.webContents, state)
  // 导航被 beforeunload 拒绝时页面仍在运行，不能提前清掉 ready。
  win.webContents.on('did-navigate', () => {
    if (!state.prepared) state.pending?.reject(new Error('页面已被其他导航替换，请检查恢复状态'))
    state.ready = false; state.prepared = false
  })
  win.webContents.on('render-process-gone', () => {
    state.ready = false
    state.pending?.reject(new Error('页面进程已退出；可重新打开仓库恢复本机状态'))
  })
  win.on('close', event => {
    if (!state.ready || state.prepared) return
    event.preventDefault()
    if (state.pending) return
    const attempt = ++state.closeAttempt
    void prepareWindow(win, 'shutdown').then(() => {
      if (state.closeAttempt === attempt && state.prepared && !win.isDestroyed()) win.close()
    }).catch(error => { if (state.closeAttempt === attempt) reportLeaveFailure(win, error) })
  })
  win.on('closed', () => state.pending?.reject(new Error('窗口已关闭')))
}

export function prepareWindow(win: BrowserWindow, reason: Reason): Promise<void> {
  if (win.isDestroyed()) return Promise.resolve()
  const state = states.get(win.webContents)
  if (!state?.ready || state.prepared) return Promise.resolve()
  if (state.pending) return state.pending.promise
  const id = randomUUID()
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const timer = setTimeout(() => reject(new Error('页面保存超过 30 秒，已保留窗口，请检查后重试')), 30000)
  const task = promise.then(() => { state.prepared = true }, error => {
    resumeWindow(win)
    throw error
  }).finally(() => { clearTimeout(timer); if (state.pending?.id === id) state.pending = undefined })
  state.pending = { id, promise: task, resolve, reject }
  win.webContents.send('page:prepare', { id, reason, recovery: state.recovery() })
  return task
}

/** 用户在异步关闭完成前重新打开同一窗口：保留它，旧 close 回调不得迟到关窗。 */
export function cancelWindowClose(win: BrowserWindow): void {
  const state = states.get(win.webContents)
  if (!state || (!state.pending && !state.prepared)) return
  state.closeAttempt++
  resumeWindow(win)
}

export const isWindowReady = (win: BrowserWindow): boolean => !win.isDestroyed() && !!states.get(win.webContents)?.ready

export const isWindowPrepared = (win: BrowserWindow): boolean => !!states.get(win.webContents)?.prepared

export function resumeWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const state = states.get(win.webContents)
  if (!state) return
  state.prepared = false
  state.pending?.reject(new Error('退出已取消，页面已保留'))
  state.pending = undefined
  win.webContents.send('page:resume')
}

export async function reloadRenderer(win: BrowserWindow): Promise<void> {
  await prepareWindow(win, 'reload')
  if (!win.isDestroyed()) win.webContents.reload()
}
export function reportLeaveFailure(win: BrowserWindow | undefined, error: unknown): void {
  if (win && !win.isDestroyed()) void dialog.showMessageBox(win, { type: 'error', message: '页面尚未保存，操作已取消', detail: String(error), buttons: ['返回'] })
}

export function registerPageLifecycleIpc(): void {
  ipcMain.on('page:ready', (event, ready: boolean) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const state = states.get(event.sender)
    if (state) state.ready = ready === true
  })
  ipcMain.on('page:prepared', (event, result: { id?: string; error?: string }) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const pending = states.get(event.sender)?.pending
    if (!pending || result?.id !== pending.id) return
    if (result.error) pending.reject(new Error(String(result.error)))
    else pending.resolve()
  })
  ipcMain.handle('page:reload', event => {
    if (event.senderFrame !== event.sender.mainFrame || !states.has(event.sender)) throw new Error('请在仓库窗口操作')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) void reloadRenderer(win).catch(error => reportLeaveFailure(win, error))
  })
}
