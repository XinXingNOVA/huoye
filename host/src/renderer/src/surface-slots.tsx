import { createContext, useCallback, useContext, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'

const parkingSlot = 'parking'
export const surfaceSlot = (kind: 'editor' | 'sidebar' | 'context', id: string) => `${kind}:${id}`
interface SurfaceListener { beforeRemove(element: HTMLElement): void; refresh(): void }

/** 每个工作区独立的临时节点登记；身份来自布局，不保存 DOM，也不参与内容生命周期。 */
export class SurfaceSlots {
  private entries = new Map<string, { element: HTMLElement }>()
  private listeners = new Set<SurfaceListener>()
  private scheduled = false
  target(id?: string) { return (id && this.entries.get(id)?.element) || this.entries.get(parkingSlot)?.element }
  register(id: string, element: HTMLElement) {
    const previous = this.entries.get(id), entry = { element }
    if (previous && previous.element !== element) this.removing(previous.element)
    this.entries.set(id, entry)
    this.refresh()
    return () => {
      // 同名新插槽已经接管时，旧 ref 的迟到清理不能注销它。
      if (this.entries.get(id) !== entry) return
      this.removing(element)
      this.entries.delete(id)
      this.refresh()
    }
  }
  subscribe(listener: SurfaceListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private removing(element: HTMLElement) { for (const listener of this.listeners) listener.beforeRemove(element) }
  refresh() {
    if (this.scheduled) return
    this.scheduled = true
    // ref 注册先完成；缺位／替换也能独立重放安放，不依赖内容再渲染一次。
    queueMicrotask(() => { this.scheduled = false; for (const listener of this.listeners) listener.refresh() })
  }
}
export const SurfaceSlotsContext = createContext<SurfaceSlots | null>(null)

export function SurfaceHost({ children }: { children: ReactNode }) {
  const [slots] = useState(() => new SurfaceSlots())
  return <SurfaceSlotsContext.Provider value={slots}>
    <SurfaceSlot slot={parkingSlot} hidden data-surface-parking="true"/>
    {children}
  </SurfaceSlotsContext.Provider>
}
/** 外壳显式提供位置；className、父子层级仅用于呈现。 */
export function SurfaceSlot({ slot, ...props }: ComponentPropsWithoutRef<'div'> & { slot: string }) {
  const slots = useContext(SurfaceSlotsContext)
  if (!slots) throw new Error('内容插槽缺少工作区宿主')
  const ref = useCallback((element: HTMLDivElement | null) => element ? slots.register(slot, element) : undefined, [slots, slot])
  return <div {...props} ref={ref}/>
}
