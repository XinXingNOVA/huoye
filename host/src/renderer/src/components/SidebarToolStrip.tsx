import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { useLayoutEffect, useRef, useState, type DragEvent, type FC } from 'react'
import { ENTITY_DRAG_TYPE } from '../entity-drag'
import type { UiHost } from '../plugin'
import { SAVED_VIEW_DRAG } from '../view-navigation'
import { SidebarViewIcon } from './icons'
import { SIDEBAR_DRAG } from './SidebarDropLayer'

interface Tool {
  readonly id: string
  readonly title: string
  readonly label?: string
  readonly iconId?: string
  readonly Icon?: FC
  readonly draggable?: boolean
}
interface Props {
  groupId: string
  kind: 'ordinary' | 'context'
  items: readonly Tool[]
  active?: string
  onSelect(id: string): void
  onMenu(id: string): void
  onDragStart(e: DragEvent, id: string): void
  onDragEnd(e?: DragEvent): void
  contextMenu: UiHost['contextMenu']
  notify: UiHost['notify']
}
export const contextPanelId = (id: string) => `context-panel-${encodeURIComponent(id)}`
const tabId = (p: Props, id: string) => `tool-tab-${encodeURIComponent(p.kind === 'context' ? `${p.groupId}:${id}` : id)}`
const acceptsSpringLoad = (dt: DataTransfer | null) =>
  !!dt &&
  !dt.types.includes(SIDEBAR_DRAG) &&
  !dt.types.includes(SAVED_VIEW_DRAG) &&
  [...dt.types].some(t => t === 'Files' || t === ENTITY_DRAG_TYPE || t === 'text/uri-list' || t === 'text/plain' || t === 'text/html')

/** 仅当前项展开名称；宽度不足时保留当前项，其余仍可从溢出菜单和键盘访问。 */
export function SidebarToolStrip(p: Props) {
  const ref = useRef<HTMLDivElement>(null), focus = useRef<string | undefined>(undefined)
  const hoverTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined)
  const hoverDepth = useRef(new Map<string, number>())
  const [width, setWidth] = useState(0)
  const clearHover = (id?: string) => {
    if (hoverTimer.current && (!id || hoverTimer.current.id === id)) {
      clearTimeout(hoverTimer.current.timer)
      hoverTimer.current = undefined
    }
    if (id) hoverDepth.current.delete(id)
    else hoverDepth.current.clear()
  }
  useUiEffect(display => {
    const el = ref.current!
    const measure = () => setWidth(el.clientWidth)
    measure(); display.observeResize(el, measure)
  }, [])
  useUiEffect(display => {
    const stop = () => clearHover()
    display.onWindow('drop', stop, true)
    display.onWindow('dragend', stop, true)
    return stop
  }, [])
  const active = p.items.find(t => t.id === p.active)
  const activeWidth = Math.min(100, 36 + Array.from(active?.label ?? active?.title ?? '').length * 12)
  const capacity = p.items.length <= 2 || width >= activeWidth + (p.items.length - 1) * 28 ? p.items.length : Math.max(1, 1 + Math.floor((width - activeWidth - 26) / 28))
  const shown = new Set(p.items.slice(0, capacity).map(t => t.id))
  if (p.active && !shown.has(p.active)) { shown.delete(p.items[capacity - 1]?.id); shown.add(p.active) }
  const visible = p.items.filter(t => shown.has(t.id)), hidden = p.items.filter(t => !shown.has(t.id))
  useLayoutEffect(() => {
    if (focus.current) { ref.current?.ownerDocument.getElementById(tabId(p, focus.current))?.focus(); focus.current = undefined }
  })
  const select = (id: string) => { focus.current = id; p.onSelect(id) }
  const overflow = async () => {
    const id = await p.contextMenu(hidden.map(t => ({ id: t.id, label: t.title })))
    if (id && hidden.some(t => t.id === id)) select(id)
  }
  return <div ref={ref} className="sidebar-tool-selector">
    <div className="sidebar-tabs" role="tablist" aria-label={p.kind === 'context' ? '当前页面工具' : '分组工具'}>
      {visible.map(tool => {
        const selected = tool.id === p.active, Icon = tool.Icon, label = tool.label ?? tool.title, iconId = tool.iconId ?? tool.id
        return <div className="sidebar-tab" key={tool.id} data-tool-id={p.kind === 'ordinary' ? tool.id : undefined} data-active={selected}
          draggable={tool.draggable !== false} onDragStart={e => p.onDragStart(e, tool.id)} onDragEnd={e => { clearHover(); p.onDragEnd(e) }}
          onDragEnter={e => {
            if (tool.id === p.active || !acceptsSpringLoad(e.dataTransfer)) return
            e.preventDefault()
            hoverDepth.current.set(tool.id, (hoverDepth.current.get(tool.id) ?? 0) + 1)
            if (hoverTimer.current?.id === tool.id) return
            clearHover(hoverTimer.current?.id)
            hoverTimer.current = {
              id: tool.id,
              timer: setTimeout(() => {
                hoverTimer.current = undefined
                hoverDepth.current.clear()
                p.onSelect(tool.id)
              }, 220),
            }
          }}
          onDragOver={e => { if (tool.id !== p.active && acceptsSpringLoad(e.dataTransfer)) e.preventDefault() }}
          onDragLeave={() => {
            const next = Math.max(0, (hoverDepth.current.get(tool.id) ?? 0) - 1)
            if (next > 0) { hoverDepth.current.set(tool.id, next); return }
            clearHover(tool.id)
          }}
          onDrop={() => clearHover()}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); p.onMenu(tool.id) }}>
          <button role="tab" id={tabId(p, tool.id)} aria-controls={p.kind === 'context' ? contextPanelId(p.groupId) : `tool-panel-${encodeURIComponent(tool.id)}`}
            aria-label={tool.title} title={tool.title} aria-selected={selected} tabIndex={selected ? 0 : -1}
            data-context-tool={p.kind === 'context' ? tool.id : undefined} onClick={() => p.onSelect(tool.id)} onKeyDown={e => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
              e.preventDefault()
              const at = p.items.findIndex(t => t.id === tool.id), next = e.key === 'Home' ? p.items[0] : e.key === 'End' ? p.items.at(-1)! : p.items[(at + (e.key === 'ArrowRight' ? 1 : -1) + p.items.length) % p.items.length]
              select(next.id)
            }}>
            {Icon ? <Icon/> : iconId.startsWith('host.') ? <SidebarViewIcon id={iconId}/> : <span className="sidebar-tool-letter" aria-hidden="true">{Array.from(label)[0]}</span>}
            <span className="sidebar-tool-label" hidden={!selected}>{label}</span>
          </button>
        </div>
      })}
    </div>
    {!!hidden.length && <button className="sidebar-tool-overflow" title={`更多工具（${hidden.length}）`} aria-label="更多工具" onClick={() => void overflow().catch(e => p.notify(String(e)))}>⌄</button>}
  </div>
}
