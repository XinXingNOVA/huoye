import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useCallback, useRef, type ReactNode } from 'react'
import type { Query } from '../../shared/query'
import { registerDropOwner, type ContentDropOwner } from '../../plugin-api/ui/internal/receive-owner'
export { contentDropOwner, type ContentDropOwner } from '../../plugin-api/ui/internal/receive-owner'

export function ContentDropBoundary(p: { title: string; enabled?: boolean; query?(zone: string): Query | undefined; children: ReactNode }) {
  useUiLocale()
  const current = useRef(p)
  current.current = p
  const bind = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const owner: ContentDropOwner = { kind: 'query', capture(zone) {
      const p = current.current
      if (!node.isConnected || p.enabled === false) throw new Error(uiText("目标工具暂不可用"))
      const query = p.query?.(zone)
      if (!query) throw new Error(uiText("当前位置不支持接收拖入的内容"))
      return { query: structuredClone(query), title: p.title }
    } }
    return registerDropOwner(node, owner)
  }, [])
  return <div ref={bind} style={{ display: 'contents' }}>{p.children}</div>
}
