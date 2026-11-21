import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useUiEffect } from './hooks'
import { useUiDocument } from './internal/document'
import { useRef, useState, useSyncExternalStore } from 'react'
import { UiPortal } from './widgets'
import type { UiHost, TextIndex } from './contracts'
export type { ContentLocator, ContentReference } from '../content-selection'
export type * from './selection-types'
import type { SelectionRect, SelectionSurfaceProps } from './selection-types'
export function useContentSelection(host: UiHost) { return useSyncExternalStore(host.selection.subscribe, host.selection.getSnapshot) }
export function selectionRect(rect: DOMRect): SelectionRect { return { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
/** 统一 DOM 选区采集生命周期，来源只负责从自己的内容解释选区。 */
export function ContentSurface(props: SelectionSurfaceProps) {
  useUiLocale()
  const doc = useUiDocument(), win = doc.defaultView!
  const { host, tabId, surfaceId, source, revision, active, root } = props
  const latest = useRef(props); latest.current = props
  const [, layout] = useState(0)
  useUiEffect(display => {
    if (!active) return
    const lease = host.selection.register({ tabId, surfaceId, sourceId: source.id, revision, select: id => latest.current.select(id) })
    const capture = (event: Event) => {
      if (event.type === 'keyup' && (event as KeyboardEvent).key === 'Escape') { lease.clear(); return }
      if ((event.target as Element)?.closest?.('[data-content-selection-ui],.qa-backdrop')) return
      try {
        const value = latest.current.read()
        if (value) lease.publish({ ...value, sourceId: source.id })
        else lease.clear()
      } catch (e) { lease.clear(); host.notify(uiText("无法读取选区：{value1}", { value1: String(String(e)) })) }
    }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') lease.clear() }
    display.onDocument('mouseup', capture); display.onDocument('keyup', capture); display.onDocument('keydown', escape)
    let cancelFrame: (() => void) | undefined
    const measure = () => { cancelFrame?.(); cancelFrame = display.frame(() => { lease.clear(); layout(v => v + 1) }) }
    display.observeResize(root, measure)
    display.onWindow('resize', measure); display.onDocument('scroll', measure, true); display.on(root, 'load', measure, true)
    return () => lease.dispose()
  }, [host, active, tabId, surfaceId, source.id, revision, root])
  if (!active) return null
  const r = root.getBoundingClientRect()
  return <UiPortal><div data-content-selection-ui className="content-selection-layers" style={{ clipPath: `inset(${Math.max(0, r.top)}px ${Math.max(0, win.innerWidth - r.right)}px ${Math.max(0, win.innerHeight - r.bottom)}px ${Math.max(0, r.left)}px)` }}>
    {host.selectionLayers().map(layer => <layer.Component key={layer.id} {...props} />)}
  </div></UiPortal>
}
/** DOM 范围的端点都必须位于来源正文；不会把工具栏或其他标签页写入摘录。 */
export function selectedText(root: HTMLElement, index: TextIndex) {
  const s = root.ownerDocument.defaultView?.getSelection(); if (!s?.rangeCount || s.isCollapsed) return
  const range = s.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  let from = index.offsetOf(range.startContainer, range.startOffset), to = index.offsetOf(range.endContainer, range.endOffset)
  if (from === undefined || to === undefined) return
  while (from < to && /\s/.test(index.text[from])) from++
  while (to > from && /\s/.test(index.text[to - 1])) to--
  if (to <= from) return
  const rect = [...range.getClientRects()].filter(r => r.width && r.height).at(-1)
  if (!rect) return
  return { from, to, text: index.text.slice(from, to), prefix: index.text.slice(Math.max(0, from - 32), from), suffix: index.text.slice(to, to + 32), rect: selectionRect(rect) }
}
