/** 同一会话的显示环境；设置独立处理输入，普通内容窗口共用工作台输入路由。 */
const windows = new Map<string, Window>()
const listeners = new Set<(win: Window, added: boolean) => void>()
let focused: Window | undefined
export function markDisplayWindow(win: Window) { focused = win }
export function displayDocument(): Document { return focused && !focused.closed ? focused.document : document }
export function displayWindows(): Window[] { return [window, ...windows.values()].filter(w => !w.closed) }
export function editorGroupDocument(group: string | undefined): Document | undefined {
  return group ? windows.get(`content:${group}`)?.document ?? document : undefined
}
export function registerDisplayWindow(id: string, win: Window) {
  windows.set(id, win)
  const focus = () => { focused = win }
  win.addEventListener('focus', focus)
  for (const listener of listeners) listener(win, true)
  return () => {
    for (const listener of listeners) listener(win, false)
    if (windows.get(id) === win) windows.delete(id)
    win.removeEventListener('focus', focus)
    if (focused === win) focused = undefined
  }
}
if (typeof window !== 'undefined') window.addEventListener('focus', () => { focused = window })
export function onDisplayEvent<K extends keyof WindowEventMap>(type: K, callback: (event: WindowEventMap[K]) => void, capture = false) {
  const apply = (win: Window, add: boolean) => add ? win.addEventListener(type, callback as EventListener, capture) : win.removeEventListener(type, callback as EventListener, capture)
  displayWindows().forEach(w => apply(w, true))
  const changed = (win: Window, add: boolean) => apply(win, add)
  listeners.add(changed)
  return () => { listeners.delete(changed); displayWindows().forEach(w => apply(w, false)) }
}
export function blurDisplayInputs() {
  for (const win of displayWindows()) (win.document.activeElement as HTMLElement | null)?.blur?.()
}
/** 跨 document 不依赖构造函数所属 realm。 */
export const asElement = (target: EventTarget | null): Element | undefined => (target as Node | null)?.nodeType === 1 ? target as Element : undefined

export function onDisplayDragCancel(cancel: () => void) {
  const key = onDisplayEvent('keydown', e => { if (e.key === 'Escape') cancel() }, true)
  const native = window.bridge.auxiliary.onDragCancel(cancel)
  return () => { key(); native() }
}
