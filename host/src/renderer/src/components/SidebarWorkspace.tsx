import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { QuickActionBar } from './QuickActionBar'
import { WorkbenchControlPopover } from './WorkbenchControlPopover'
import { useToolDrag } from './ToolDrag'
import type { SidebarContainerSnapshot, SidebarSnapshot } from '../workbench-containers'
import type { ContainerActions } from '../app/container-actions'
import type { DockTarget } from '../workbench-placement'
import type { WorkspaceDocking } from '../app/workspace-docking'
import { sidebarMenus } from './sidebar-menus'
import { measureSidebarPair } from './workbench-geometry'
import { resolveSidebarContainer, sidebarContainerSlot, type SidebarContainerInteractions } from './SidebarContainers'
import { ContextToolSurfaces } from './ContextToolSurfaces'
import { SidebarDropLayer, type SidebarDropTarget } from './SidebarDropLayer'
import { useRef, useState, type ReactNode } from 'react'
import { GripIcon } from './icons'
import type { UiHost } from '../plugin'
import type { SidebarSide } from '../sidebar-layout'
import { PanelResizeHandle } from './WindowContributions'
import { PanelToggle } from './PanelToggle'
import { WindowsTitleBar } from './WindowsTitleBar'

interface Props {
  host: UiHost; snapshot: SidebarSnapshot; actions: ContainerActions
  widths: Record<SidebarSide, number>
  libraryTitle: string; status: ReactNode; onCommand(): void
  onResizing(active: boolean): void
  docking: WorkspaceDocking
  hostForPage(id: string): UiHost; onLocate(id: string): void
}
/** 两侧是纵向工具组；稳定 Portal 持有内容，位置和显隐不改变插件实例。 */
export function SidebarWorkspace(p: Props) {
  useUiLocale()
  const [layoutOpen, setLayoutOpen] = useState(false)
  const { value, start, end } = useToolDrag(), dragging = !!value, drag = { current: value }
  const { tools: views, groups: allGroups, regions } = p.snapshot
  const groupsFor = (side: SidebarSide) => allGroups.filter(c => c.present && c.side === side)
  const { reveal, viewMenu, contextToolMenu, groupMenu, toolsMenu } = sidebarMenus(p)
  const dropTarget = (side: SidebarSide, target: SidebarDropTarget): DockTarget => ({ region: side, group: target.group, edge: target.edge, before: target.beforeView })
  const dropReason = (side: SidebarSide, target: SidebarDropTarget, height: number) => drag.current
    ? p.docking.preview(drag.current, dropTarget(side, target), height) : uiText("拖动已取消")
  const place = (side: SidebarSide, target: SidebarDropTarget) => { if (drag.current) p.docking.place(drag.current, dropTarget(side, target)) }
  const report = (task: Promise<unknown>) => { void task.catch(e => p.host.notify(String(e))) }
  const actionsFor = (c: SidebarContainerSnapshot): SidebarContainerInteractions => ({
    select: reveal,
    menuTool: id => { const view = views.find(v => v.id === id); if (view) report(viewMenu(view)) },
    selectContextTool: id => { if (c.context?.source) p.actions.configureContext(c.id, c.context.source, { type: 'select', tool: id }) },
    menuContextTool: id => report(contextToolMenu(c, id)),
    dragTool: (e, id) => start(e, { type: 'view', id }),
    dragContextTool: (e, id, pageId) => start(e, { type: 'context-tool', id, pageId, containerId: c.id }),
    endDrag: end, locatePage: p.onLocate,
    contextMenu: p.host.contextMenu, notify: p.host.notify
  })
  return <>
    {window.bridge.platform === 'win32' ? <WindowsTitleBar title={p.libraryTitle} /> : <div className="window-corner" aria-hidden="true" />}
    <QuickActionBar
      host={p.host}
      libraryTitle={p.libraryTitle}
      status={p.status}
      layoutOpen={layoutOpen}
      onCommand={p.onCommand}
      onLayout={() => setLayoutOpen(v => !v)}
    />
    {layoutOpen && (
      <WorkbenchControlPopover
        host={p.host}
        snapshot={p.snapshot}
        actions={p.actions}
        onRevealTool={reveal}
        onClose={() => setLayoutOpen(false)}
      />
    )}
    {(['left', 'right'] as const).map(side => {
      const groups = groupsFor(side)
      const totalWeight = groups.reduce((sum, g) => sum + g.weight, 0)
      return <div key={side} id={side === 'left' ? 'sidebar-panel' : 'inspector-panel'} className="side-panel" inert={!regions[side].visible} aria-hidden={!regions[side].visible}>
        <div className={`dock-shell dock-${side}`} data-workbench-region={side} data-dragging={dragging} onKeyDown={e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation() }}>
          <div className="sidebar-groups">
            {groups.map((c, index) => {
              const { Header, Body } = resolveSidebarContainer(c), next = groups[index + 1]
              const content = { snapshot: c, actions: actionsFor(c), slot: sidebarContainerSlot(c.type, c.id) }
              // 归一化可见容器权重，避免移除某容器后剩余 flex-grow 总和 < 1 导致侧栏底部留空（CSS Flexbox §9.7）
              const grow = totalWeight > 0 ? (c.weight / totalWeight) * 100 : 1
              return <section key={c.id} className="sidebar-group" data-context-source={c.context?.source?.pageId} data-context-type={c.context?.source?.type} data-container-id={c.id} data-container-type={c.type} data-first={index === 0} style={{ flex: `${grow} 1 0` }}>
                <div className="sidebar-group-heading" data-container-header
                  onContextMenu={e => { e.preventDefault(); report(groupMenu(c)) }}>
                  <button className="sidebar-group-grip" draggable onDragStart={e => start(e, { type: 'container', id: c.id })} onDragEnd={end}
                    title={uiText("移动整组；点击打开分组菜单")} aria-label={uiText("移动工具组 {value1}", { value1: String(index + 1) })} onClick={() => report(groupMenu(c))}><GripIcon/></button>
                  <Header {...content}/>
                  {index === 0 && <span className="window-drag-space" aria-hidden="true"/>}
                  <button className="sidebar-group-menu" draggable onDragStart={e => start(e, { type: 'container', id: c.id })} onDragEnd={end} title={uiText("分组与工具")} aria-label={uiText("工具组 {value1} 菜单", { value1: String(index + 1) })} onClick={() => report(groupMenu(c))}>···</button>
                  {index === 0 && <PanelToggle side={side} expanded={regions[side].visible} onToggle={() => p.actions.setVisible(side, false)}/>}
                </div>
                <Body {...content}/>
                {next && <GroupResize first={c} second={next} onRatio={ratio => p.actions.resizeGroups(c.id, next.id, ratio)}/>}
              </section>
            })}
            {!groups.length && <div className="sidebar-empty">
              <div className="sidebar-group-heading"><span>{uiText("工具")}</span><PanelToggle side={side} expanded={regions[side].visible} onToggle={() => p.actions.setVisible(side, false)}/></div>
              <button onClick={() => void toolsMenu()}>{uiText("添加或打开工具…")}</button>
              {regions[side].hasUnavailable && <small className="muted">{uiText("部分插件暂不可用，已保留位置")}</small>}
            </div>}
          </div>
          {dragging && <SidebarDropLayer copying={drag.current?.type === 'context-tool'} groupOnly={drag.current?.type === 'container' && allGroups.find(c => c.id === drag.current?.id)?.type === 'context'} blocked={(target, height) => dropReason(side, target, height)} onDrop={target => place(side, target)} onEnd={end}/>}
        </div>
        <PanelResizeHandle side={side} width={p.widths[side]} onResize={n => p.actions.resizeRegion(side, n)} onDragging={p.onResizing}/>
      </div>
    })}
    <ContextToolSurfaces instances={p.snapshot.contextInstances} hostForPage={p.hostForPage}/>

  </>
}

function GroupResize({ first, second, onRatio }: { first: SidebarContainerSnapshot; second: SidebarContainerSnapshot; onRatio(ratio: number): void }) {
  useUiLocale()
  const drag = useRef<{ y: number; height: number; weight: number; total: number } | null>(null)
  const total = first.weight + second.weight, ratio = first.weight / total
  const update = (part: number) => onRatio(Math.min(.9, Math.max(.1, part)))
  return <div className="tool-view-resize" role="separator" aria-label={uiText("调整分组高度")} aria-orientation="horizontal" tabIndex={0} aria-valuenow={Math.round(100 * ratio)} aria-valuemin={10} aria-valuemax={90}
    onPointerDown={e => {
      if (e.button !== 0) return
      e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { y: e.clientY, height: measureSidebarPair(e.currentTarget, second.id), weight: first.weight, total }
    }}
    onPointerMove={e => { const d = drag.current; if (d) update(d.weight / d.total + (e.clientY - d.y) / d.height) }}
    onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
    onDoubleClick={() => update(.5)} onKeyDown={e => { if (['ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); update(e.key === 'Home' ? .5 : ratio + (e.key === 'ArrowDown' ? .05 : -.05)) } }}/>
}
