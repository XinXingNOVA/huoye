import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { onDisplayEvent, onDisplayDragCancel } from '../display-windows'
import { outsideDropPoint } from './EditorDrag'
import { SIDEBAR_DRAG, type SidebarDrag } from './SidebarDropLayer'
interface ToolDrag { value?: SidebarDrag; start(e: DragEvent, value: SidebarDrag): void; end(e?: DragEvent): void }
const Context = createContext<ToolDrag | null>(null)
/** 整个窗口共用布局拖动；只接受本窗口创建的载荷。原生起拖后才开启命中层。 */
export function ToolDragProvider({ children, detach }: { children: ReactNode; detach(value: SidebarDrag, point: { x: number; y: number }): void }) {
  const [value, setValue] = useState<SidebarDrag>(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const current = useRef<SidebarDrag | undefined>(undefined), detachRef = useRef(detach)
  detachRef.current = detach
  const end = (e?: DragEvent) => {
    clearTimeout(timer.current)
    const source = current.current; current.current = undefined; setValue(undefined)
    const point = e && outsideDropPoint(e)
    if (source && source.type !== 'container' && point) detachRef.current(source, point)
  }
  useEffect(() => {
    const offKey = onDisplayDragCancel(() => end())
    const offEnd = onDisplayEvent('dragend', () => end())
    return () => { clearTimeout(timer.current); offKey(); offEnd() }
  }, [])
  return <Context.Provider value={{ value, end, start(e, next) {
    current.current = next
    e.stopPropagation(); e.dataTransfer.setData(SIDEBAR_DRAG, JSON.stringify(next)); e.dataTransfer.effectAllowed = next.type === 'context-tool' ? 'copy' : 'move'
    clearTimeout(timer.current); timer.current = setTimeout(() => setValue(next), 0)
  } }}>{children}</Context.Provider>
}
export const useToolDrag = () => useContext(Context)!
