import { useCallback, useLayoutEffect, useRef, type DependencyList } from 'react'
import { useUiDocument } from './document'

/** 一次显示环境绑定。所有登记的资源在移窗／依赖变化／卸载时自动清理。 */
export interface UiDisplayEffect {
  readonly document: Document
  readonly window: Window & typeof globalThis
  onWindow<K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void, options?: boolean | AddEventListenerOptions): () => void
  onDocument<K extends keyof DocumentEventMap>(type: K, listener: (event: DocumentEventMap[K]) => void, options?: boolean | AddEventListenerOptions): () => void
  on<K extends keyof HTMLElementEventMap>(element: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: boolean | AddEventListenerOptions): () => void
  observeResize(elements: Element | readonly Element[], callback: ResizeObserverCallback): () => void
  observeIntersection(elements: Element | readonly Element[], callback: IntersectionObserverCallback, options?: IntersectionObserverInit): () => void
  observeMutations(node: Node, callback: MutationCallback, options: MutationObserverInit): () => void
  /** 单次绘制回调；回调中可继续排下一帧。返回取消函数，无需管理跨窗口的帧编号。 */
  frame(callback: FrameRequestCallback): () => void
}

function displayScope(document: Document): UiDisplayEffect & { dispose(): void } {
  const window = document.defaultView!
  const resources = new Set<() => void>()
  let disposed = false
  const track = (cleanup: () => void) => {
    if (disposed) { cleanup(); return () => {} }
    const off = () => { if (resources.delete(off)) cleanup() }
    resources.add(off)
    return off
  }
  const listen = (target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
    target.addEventListener(type, listener, options)
    return track(() => target.removeEventListener(type, listener, options))
  }
  const observe = (elements: Element | readonly Element[], observer: ResizeObserver | IntersectionObserver) => {
    const off = track(() => observer.disconnect())
    if (!disposed) for (const element of Array.isArray(elements) ? elements : [elements]) observer.observe(element)
    return off
  }
  return {
    document, window,
    onWindow: (type, listener, options) => listen(window, type, listener as EventListener, options),
    onDocument: (type, listener, options) => listen(document, type, listener as EventListener, options),
    on: (element, type, listener, options) => listen(element, type, listener as EventListener, options),
    observeResize: (elements, callback) => observe(elements, new window.ResizeObserver((entries, observer) => { if (!disposed) callback(entries, observer) })),
    observeIntersection: (elements, callback, options) => observe(elements, new window.IntersectionObserver((entries, observer) => { if (!disposed) callback(entries, observer) }, options)),
    observeMutations(node, callback, options) {
      const observer = new window.MutationObserver((records, current) => { if (!disposed) callback(records, current) })
      const off = track(() => observer.disconnect())
      if (!disposed) observer.observe(node, options)
      return off
    },
    frame(callback) {
      if (disposed) return () => {}
      const id = window.requestAnimationFrame(time => { off(); if (!disposed) callback(time) })
      const off = track(() => window.cancelAnimationFrame(id))
      return off
    },
    dispose() { disposed = true; for (const off of resources) off() }
  }
}

/** 与 layout effect 相同的依赖语义；另外自动跟随内容的显示文档。业务保存／服务生命周期不放在这里。 */
export function useUiEffect(setup: (display: UiDisplayEffect) => void | (() => void), dependencies: DependencyList) {
  const document = useUiDocument()
  useLayoutEffect(() => {
    const display = displayScope(document)
    let cleanup: void | (() => void)
    try { cleanup = setup(display) } catch (error) { display.dispose(); throw error }
    return () => { display.dispose(); cleanup?.() }
  }, [document, ...dependencies])
}

/** 事件处理器需要下一帧时使用；移窗／卸载自动取消尚未执行的旧回调。 */
export function useUiFrame(): UiDisplayEffect['frame'] {
  const display = useRef<UiDisplayEffect | undefined>(undefined)
  useUiEffect(current => { display.current = current; return () => { display.current = undefined } }, [])
  return useCallback(callback => display.current?.frame(callback) ?? (() => {}), [])
}
