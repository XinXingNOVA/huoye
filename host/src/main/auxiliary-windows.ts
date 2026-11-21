import { windowChrome } from './window-options'
import { isWindowPrepared } from './page-lifecycle'
import { app, BrowserWindow, ipcMain, screen, shell, type WebContents } from 'electron'
import type { AuxiliaryKind, AuxiliaryEvent, WindowBounds } from '../shared/auxiliary-windows'

interface Attached { owner: BrowserWindow; win: BrowserWindow; kind: AuxiliaryKind; ready?: boolean }
const attached = new Map<BrowserWindow, Attached>()
const installed = new WeakSet<BrowserWindow>()
const pending = new WeakMap<BrowserWindow, Map<AuxiliaryKind, Partial<WindowBounds>>>()
const background = new WeakSet<BrowserWindow>()
const windowVersions = new WeakMap<BrowserWindow, { revision: number; targetChangedAt: number }>()
const lastSessionWindow = new WeakMap<BrowserWindow, BrowserWindow>()
const visibleWindows = new WeakMap<BrowserWindow, boolean>()
function touchSession(owner: BrowserWindow, targetChanged = true) {
  const previous = windowVersions.get(owner)
  const revision = (previous?.revision ?? 0) + 1
  windowVersions.set(owner, { revision, targetChangedAt: targetChanged ? revision : previous?.targetChangedAt ?? 0 })
}
function observeVisibility(owner: BrowserWindow, win: BrowserWindow) {
  const visible = win.isVisible() && !win.isMinimized()
  if (visibleWindows.has(win) && visibleWindows.get(win) !== visible) touchSession(owner)
  visibleWindows.set(win, visible)
  return visible
}
function trackSessionWindow(owner: BrowserWindow, win: BrowserWindow) {
  const changed = () => { touchSession(owner) }
  const observe = () => observeVisibility(owner, win)
  observe()
  // 系统切到 AI 客户端再回来，目标内容仍是原窗口。切换本库窗口才改变操作现场。
  win.on('focus', () => {
    observe()
    touchSession(owner, (lastSessionWindow.get(owner) ?? owner) !== win)
    lastSessionWindow.set(owner, win)
  })
  win.on('blur', () => { observe(); touchSession(owner, false) })
  win.on('show', changed); win.on('hide', changed)
  win.on('minimize', changed); win.on('restore', changed)
  win.on('closed', () => {
    if (lastSessionWindow.get(owner) === win) lastSessionWindow.delete(owner)
    changed()
  })
}
/** 仅返回本库原生窗口；内容焦点由工作区提供，设置窗口不冒充集合页面。 */
export function workbenchSessionWindows(owner: BrowserWindow): import('../shared/workbench-session').SessionWindows {
  const all = [{ id: 'main', win: owner }, ...[...attached.values()].filter(e => e.owner === owner).map(e => ({ id: e.kind, win: e.win }))]
  const windows = all.filter(e => !e.win.isDestroyed()).map(({ id, win }) => ({ id, visible: observeVisibility(owner, win), focused: win.isFocused() }))
  return { revision: windowVersions.get(owner)?.revision ?? 0, focused: windows.find(w => w.focused)?.id ?? null, windows }
}
/** 允许期间只有系统焦点变化；仓库内换窗、显隐与窗口增删均使更早的凭据失效。 */
export function matchesPresentationWindow(owner: BrowserWindow, expected: number) {
  const { revision } = workbenchSessionWindows(owner)
  return expected <= revision && expected >= (windowVersions.get(owner)?.targetChangedAt ?? 0)
}
export function workbenchContentWindow(owner: BrowserWindow, id: string): BrowserWindow | undefined {
  if (id === 'main') return owner.isDestroyed() ? undefined : owner
  return [...attached.values()].find(e => e.owner === owner && e.kind !== 'settings' && e.kind === id && !e.win.isDestroyed())?.win
}
/** 隐藏库恢复的小窗先装配，不自行亮窗；显式显示仓库时一并展示已就绪的附属画面。 */
export function setLibraryBackground(owner: BrowserWindow, hidden: boolean) {
  if (hidden) background.add(owner)
  else {
    background.delete(owner)
    for (const entry of attached.values()) if (entry.owner === owner && entry.ready && !entry.win.isDestroyed()) entry.win.showInactive()
  }
}
const validKind = (kind: unknown): kind is AuxiliaryKind => kind === 'settings' || typeof kind === 'string' && /^content:[a-zA-Z0-9_-]{1,100}$/.test(kind)
const notify = (entry: Attached, type: AuxiliaryEvent['type'], extra: Partial<AuxiliaryEvent> = {}) => {
  if (!entry.owner.isDestroyed()) entry.owner.webContents.send('auxiliary:event', { kind: entry.kind, type, ...extra } satisfies AuxiliaryEvent)
}
export function auxiliaryKind(win: BrowserWindow) { return attached.get(win)?.kind }
export function auxiliaryOwner(win: BrowserWindow): BrowserWindow { return attached.get(win)?.owner ?? win }
/** 业务 IPC 仍来自权威窗口，系统弹窗与菜单跟随它当前获焦的附属窗口。 */
export function presentationWindow(sender: WebContents): BrowserWindow | undefined {
  const owner = BrowserWindow.fromWebContents(sender), focused = BrowserWindow.getFocusedWindow()
  return focused && attached.get(focused)?.owner === owner ? focused : owner ?? undefined
}
export function closeAuxiliaryWindows(owner: BrowserWindow): void {
  for (const entry of attached.values()) if (entry.owner === owner && !entry.win.isDestroyed()) entry.win.destroy()
  pending.delete(owner)
}
export function routeAuxiliaryCommand(win: BrowserWindow, command: string): boolean {
  const entry = attached.get(win)
  if (!entry) return false
  if (entry.kind !== 'settings') {
    // 先同步操作页，再走与主窗口相同的命令路由，包括编辑会话撤销。
    notify(entry, 'focus'); entry.owner.webContents.send('menu:command', command)
  } else if (command === 'tab.close') notify(entry, 'close-request')
  else if (command === 'settings') win.focus()
  else if (command === 'find') notify(entry, 'find')
  else if (command === 'undo') win.webContents.undo()
  else if (command === 'redo') win.webContents.redo()
  else if (command === 'selectAll') win.webContents.selectAll()
  else if (command === 'trash') win.webContents.delete()
  return true
}
function boundsFor(owner: BrowserWindow, input: Partial<WindowBounds>, centered = false): WindowBounds {
  const original = owner.getBounds()
  const requested = { x: input.x ?? original.x + 40, y: input.y ?? original.y + 40, width: input.width ?? 900, height: input.height ?? 700 }
  const area = screen.getDisplayMatching(centered ? original : requested).workArea
  const width = Math.min(area.width, Math.max(320, requested.width)), height = Math.min(area.height, Math.max(240, requested.height))
  const x = centered ? Math.round(original.x + (original.width - width) / 2) : requested.x
  const y = centered ? Math.round(original.y + (original.height - height) / 2) : requested.y
  return { width, height, x: Math.max(area.x, Math.min(area.x + area.width - width, x)), y: Math.max(area.y, Math.min(area.y + area.height - height, y)) }
}
/** 同源画面共享 owner 的运行环境；窗口仅是已登记内容的呈现位置。 */
export function installAuxiliaryWindows(owner: BrowserWindow): void {
  if (installed.has(owner)) return
  installed.add(owner)
  trackSessionWindow(owner, owner)
  const trackDragCancel = (win: BrowserWindow) => win.webContents.on('before-input-event', (_event, input) => {
    // 原生拖放期间 Escape 可能被 Chromium 消费，不抵达页面的 keydown。
    if (input.type === 'keyDown' && input.key === 'Escape' && !owner.isDestroyed()) owner.webContents.send('auxiliary:drag-cancel')
  })
  trackDragCancel(owner)
  owner.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const kind = frameName.startsWith('rm-') ? frameName.slice(3) : undefined
    if (url !== 'about:blank' || !validKind(kind) || kind !== 'settings' && !pending.get(owner)?.has(kind)) {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    }
    const existing = [...attached.values()].find(e => e.owner === owner && e.kind === kind)
    if (existing) { if (!background.has(owner)) existing.win.focus(); return { action: 'deny' } }
    const bounds = boundsFor(owner, kind === 'settings' ? { width: 1040, height: 780 } : pending.get(owner)?.get(kind) ?? {}, kind === 'settings')
    pending.get(owner)?.delete(kind)
    return { action: 'allow', overrideBrowserWindowOptions: {
      // 所有附属画面独立摆放；会话归属由 attached 管理，不使用原生 parent 联动位置。
      ...windowChrome(), modal: false, show: false,
      title: kind === 'settings' ? '设置' : app.name, ...bounds,
      minWidth: kind === 'settings' ? 720 : 320, minHeight: kind === 'settings' ? 480 : 240,
      backgroundColor: '#1a1b1e', webPreferences: { preload: undefined, nodeIntegration: false, contextIsolation: true, sandbox: true }
    } }
  })
  owner.webContents.on('did-create-window', (win, details) => {
    const kind = details.frameName.slice(3) as AuxiliaryKind
    const entry: Attached = { owner, win, kind }
    attached.set(win, entry)
    touchSession(owner); trackSessionWindow(owner, win)
    trackDragCancel(win)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.on('close', event => {
      if (isWindowPrepared(owner)) return
      event.preventDefault(); notify(entry, 'close-request')
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const recordBounds = () => { clearTimeout(timer); timer = setTimeout(() => { if (!win.isDestroyed()) notify(entry, 'bounds', { bounds: win.getNormalBounds() }) }, 160) }
    win.on('move', recordBounds); win.on('resize', recordBounds)
    win.on('focus', () => notify(entry, 'focus'))
    win.on('closed', () => { clearTimeout(timer); attached.delete(win); notify(entry, 'closed') })
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy() })
  })
  owner.webContents.on('did-navigate', () => closeAuxiliaryWindows(owner))
  owner.webContents.on('render-process-gone', () => closeAuxiliaryWindows(owner))
  owner.on('closed', () => closeAuxiliaryWindows(owner))
}
export function registerAuxiliaryWindowIpc(): void {
  for (const action of ['prepare', 'show', 'focus', 'close'] as const) ipcMain.handle(`auxiliary:${action}`, (event, kind: unknown, raw?: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || !installed.has(owner) || event.senderFrame !== event.sender.mainFrame || !validKind(kind)) throw new Error('附属窗口请求无效')
    if (action === 'prepare') {
      const bounds: Partial<WindowBounds> = {}
      if (raw && typeof raw === 'object') for (const k of ['x','y','width','height'] as const) {
        const v = (raw as WindowBounds)[k]
        if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100000) bounds[k] = Math.round(v)
      }
      let requests = pending.get(owner)
      if (!requests) { requests = new Map(); pending.set(owner, requests) }
      if (requests.size >= 64 && !requests.has(kind)) throw new Error('待创建窗口过多')
      requests.set(kind, bounds); return
    }
    const entry = [...attached.values()].find(e => e.owner === owner && e.kind === kind)
    if (!entry || entry.win.isDestroyed()) return
    if (action === 'close') entry.win.destroy()
    else {
      entry.ready = true
      if (background.has(owner)) return
      if (action === 'show') entry.win.showInactive()
      else { entry.win.show(); if (entry.win.isMinimized()) entry.win.restore(); entry.win.focus() }
    }
  })
}
