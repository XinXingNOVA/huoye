import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useEntityState } from './data'
import { registerDropOwner } from './internal/receive-owner'
import type { ReceiveIntent, ReceiveDelivery, ViewReceiveBatch } from '../../shared/transfer'
export type { ReceiveIntent, ReceiveItem, ReceiveDelivery, ViewReceiveBatch } from '../../shared/transfer'

/** capture 同步锁定业务目标与落点。identity 改变或实例卸载后，旧回执不再投递。 */
export function ReceiveSurface(props: ItemSurfaceProps | ViewSurfaceProps | { mode: 'transient'; children: ReactNode }) {
  if ('mode' in props) return <TransientSurface>{props.children}</TransientSurface>
  return 'viewId' in props ? <ViewSurface {...props}/> : <ItemSurface {...props}/>
}
// Children handle ordinary DOM File / DataTransfer events. No import or download takes place.
function TransientSurface({ children }: { children: ReactNode }) {
  const bind = useCallback((node: HTMLDivElement | null) => node ? registerDropOwner(node, { kind: 'transient' }) : undefined, [])
  return <div ref={bind} data-hy-receive-surface="" style={{ display: 'contents' }}>{children}</div>
}
interface ViewSurfaceProps {
  viewId: string
  onBatch(event: ViewReceiveBatch): void
  onHover?(inside: boolean): void
  children: ReactNode
}
function ViewSurface(props: ViewSurfaceProps) {
  useEntityState(props.viewId)
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props }, [props])
  const bind = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const lifetime = new AbortController()
    const off = registerDropOwner(node, { kind: 'view', viewId: () => latest.current.viewId, signal: lifetime.signal,
      hover: inside => latest.current.onHover?.(inside),
      batch(event) { if (!lifetime.signal.aborted && latest.current.viewId === event.viewId) latest.current.onBatch(event) }
    })
    return () => { lifetime.abort(); off() }
  }, [])
  return <div ref={bind} data-hy-receive-surface="" style={{ display: 'contents' }}>{props.children}</div>
}
interface ItemSurfaceProps {
  identity: string
  capture(intent: ReceiveIntent): ReceiveDelivery
  children: ReactNode
}
function ItemSurface({ identity, capture, children }: ItemSurfaceProps) {
  const latest = useRef(capture)
  useLayoutEffect(() => { latest.current = capture }, [capture])
  const bind = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    let mounted = true
    const off = registerDropOwner(node, { kind: 'items', isCurrent: () => mounted && node.isConnected, capture(intent) {
      const deliver = latest.current(intent)
      return items => {
        if (mounted && node.isConnected) return deliver(items)
      }
    } })
    return () => { mounted = false; off() }
  }, [identity])
  return <div ref={bind} data-hy-receive-surface="" style={{ display: 'contents' }}>{children}</div>
}
