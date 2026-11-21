import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useCallback, useRef, type ReactNode } from 'react'
import type { Query } from '../../shared/query'

/** 按实际内容实例登记；DOM 随 RetainedSurface 移动，绑定与规则不按窗口或侧栏重猜。 */
export interface ContentDropOwner { capture(zone: string): { query: Query; title: string } }
const owners = new WeakMap<Element, ContentDropOwner>()
export function contentDropOwner(element: Element | null): ContentDropOwner | undefined {
  for (let node = element; node; node = node.parentElement) {
    const owner = owners.get(node)
    if (owner) return owner
  }
}
export function ContentDropBoundary(p: { title: string; enabled?: boolean; query?(zone: string): Query | undefined; children: ReactNode }) {
  useUiLocale()
  const current = useRef(p)
  current.current = p
  const bind = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const owner: ContentDropOwner = { capture(zone) {
      const p = current.current
      if (!node.isConnected || p.enabled === false) throw new Error(uiText("目标工具暂不可用"))
      const query = p.query?.(zone)
      if (!query) throw new Error(uiText("当前位置不支持接收拖入的内容"))
      return { query: structuredClone(query), title: p.title }
    } }
    owners.set(node, owner)
    return () => { owners.delete(node) }
  }, [])
  return <div ref={bind} style={{ display: 'contents' }}>{p.children}</div>
}
