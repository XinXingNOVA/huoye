import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { displayWindows, onDisplayDragCancel } from '../display-windows'
export const TAB_DRAG = 'application/x-rm-editor-tab'
interface DragSession { readonly id?: string; start(e: DragEvent, id: string): void; end(e?: DragEvent): void }
const Context = createContext<DragSession | null>(null)
/** 载荷只引用本会话正在拖动的实例，不信任别的窗口/应用伪造的 ID。 */
export function EditorDragProvider({ children, detach }: { children: ReactNode; detach(id: string, point: { x: number; y: number }): void }) {
  const current = useRef<string | undefined>(undefined), [, changed] = useState(0), detachRef = useRef(detach)
  detachRef.current = detach
  const end = (e?: DragEvent) => {
    const id = current.current; current.current = undefined; changed(n => n + 1)
    const point = e && outsideDropPoint(e)
    if (id && point) detachRef.current(id, point)
  }
  useEffect(() => onDisplayDragCancel(() => end()), [])
  return <Context.Provider value={{ get id() { return current.current }, start(e, id) {
    current.current = id; e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(TAB_DRAG, id); changed(n => n + 1)
  }, end }}>{children}</Context.Provider>
}
export const useEditorDrag = () => useContext(Context)!

export function outsideDropPoint(e: Pick<DragEvent, 'dataTransfer' | 'screenX' | 'screenY'>): { x: number; y: number } | undefined {
  if (e.dataTransfer.dropEffect !== 'none' || !e.screenX && !e.screenY) return
  const inside = displayWindows().some(w => e.screenX >= w.screenX && e.screenX < w.screenX + w.outerWidth && e.screenY >= w.screenY && e.screenY < w.screenY + w.outerHeight)
  if (!inside) return { x: e.screenX - 80, y: e.screenY - 20 }
}
