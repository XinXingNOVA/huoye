import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useState, type CSSProperties, type DragEvent } from 'react'

import { hitSidebarDrop, type SidebarDropTarget } from '../workbench-hit-test'
import { measureRect, measureSidebarGroups } from './workbench-geometry'

export const SIDEBAR_DRAG = 'application/x-rm-tool-layout'
export type { DockSource as SidebarDrag } from '../workbench-placement'
export type { SidebarDropTarget } from '../workbench-hit-test'
interface DropPreview { target: SidebarDropTarget; rect: CSSProperties; reason?: string }
interface Props {
  groupOnly?: boolean
  copying?: boolean
  blocked(target: SidebarDropTarget, height: number): string | undefined
  onDrop(target: SidebarDropTarget): void
  onEnd(): void
}

/** 仅布局拖动时覆盖侧栏，避免工具的 iframe、输入框或业务拖放截获落点。 */
export function SidebarDropLayer(p: Props) {
  useUiLocale()
  const [over, setOver] = useState<DropPreview>()
  const hit = (e: DragEvent<HTMLDivElement>): DropPreview => {
    const layer = e.currentTarget, bounds = measureRect(layer)
    const { target, rect } = hitSidebarDrop(bounds, measureSidebarGroups(layer.parentElement!), { x: e.clientX, y: e.clientY }, p.groupOnly)
    return { target, rect: { left: rect.x, top: rect.y, width: rect.width, height: rect.height }, reason: p.blocked(target, bounds.height) }
  }
  const accept = (e: DragEvent) => e.dataTransfer.types.includes(SIDEBAR_DRAG)
  return <div className="sidebar-layout-drop-layer" aria-hidden="true"
    onDragOver={e => {
      if (!accept(e)) return
      e.preventDefault(); e.stopPropagation(); const next = hit(e)
      e.dataTransfer.dropEffect = next.reason ? 'none' : p.copying ? 'copy' : 'move'
      setOver(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
    }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(undefined) }}
    onDrop={e => {
      if (!accept(e)) return
      e.preventDefault(); e.stopPropagation(); const next = hit(e)
      if (!next.reason) p.onDrop(next.target)
      p.onEnd()
    }}>
    {over && <div className="sidebar-layout-drop-preview" data-edge={over.target.edge ?? (over.target.group ? 'join' : 'empty')} data-blocked={!!over.reason} style={over.rect}>
      <span>{over.reason ?? <>{p.copying ? uiText("固定原页面 · ") : ''}{(over.target.edge === 'top' ? uiText("放到上方独立分组") : over.target.edge === 'bottom' ? uiText("放到下方独立分组") : over.target.group ? uiText("加入此工具组") : uiText("在此放置工具"))}</>}</span>
    </div>}
  </div>
}
