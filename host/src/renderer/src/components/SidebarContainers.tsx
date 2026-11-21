import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import type { DragEvent, FC } from 'react'
import type { SidebarContainerSnapshot } from '../workbench-containers'
import type { UiHost } from '../plugin'
import type { WorkbenchRegion } from '../workbench-content'
import { SurfaceSlot, surfaceSlot } from '../surface-slots'
import { SidebarToolStrip, contextPanelId } from './SidebarToolStrip'
import { LinkIcon } from './icons'

/** 仅针对当前组的呈现动作；不交出工作区写入器、插件组件或页面运行时能力。 */
export interface SidebarContainerInteractions {
  select(id: string): void
  menuTool(id: string): void
  selectContextTool(id: string): void
  menuContextTool(id: string): void
  dragTool(e: DragEvent, id: string): void
  dragContextTool(e: DragEvent, id: string, pageId: string): void
  endDrag(e?: DragEvent): void
  locatePage(id: string): void
  contextMenu: UiHost['contextMenu']
  notify: UiHost['notify']
}
interface ContainerProps {
  snapshot: SidebarContainerSnapshot
  actions: SidebarContainerInteractions
  /** 宿主分配稳定插槽身份，外壳仅决定其 DOM 位置与样式。 */
  slot: string
}
interface SidebarContainerDefinition {
  readonly regions: readonly WorkbenchRegion[]
  readonly source: 'members' | 'page-context'
  readonly Header: FC<ContainerProps>
  readonly Body: FC<ContainerProps>
}
function ContextSource({ id, title, onLocate }: { id?: string; title: string; onLocate(id: string): void }) {
  useUiLocale()
  const label = id ? uiText("跟随：{title}；点击定位页面", { title }) : title
  return <button className="sidebar-tool-source" disabled={!id} title={label} aria-label={label} data-source-page={id} onClick={() => id && onLocate(id)}>
    <LinkIcon/><span>{title}</span>
  </button>
}
function TabsHeader({ snapshot: c, actions: a }: ContainerProps) {
  useUiLocale()
  return <SidebarToolStrip groupId={c.id} kind="ordinary" items={c.items.map(t => ({ ...t, iconId: t.typeId,
    title: t.source ? uiText("{label} · 固定到：{title}{value3}", { label: String(t.label), title: String(t.source.title), value3: String(t.source.available ? '' : uiText("（页面已关闭）")) }) : t.title
  }))} active={c.active} onSelect={a.select} onMenu={a.menuTool} onDragStart={a.dragTool} onDragEnd={a.endDrag}
    contextMenu={a.contextMenu} notify={a.notify}/>
}
function ContextHeader({ snapshot: c, actions: a }: ContainerProps) {
  useUiLocale()
  const context = c.context!
  return <>
    {!context.items.length ? <span className="sidebar-tool-placeholder">{uiText("页面工具")}</span> : <SidebarToolStrip groupId={c.id} kind="context" items={context.items.map(t => ({ ...t, draggable: t.detachable }))} active={context.active}
      onSelect={a.selectContextTool} onMenu={a.menuContextTool} onDragStart={(e, id) => { if (context.source) a.dragContextTool(e, id, context.source.pageId); else e.preventDefault() }}
      onDragEnd={a.endDrag} contextMenu={a.contextMenu} notify={a.notify}/>}
    <ContextSource id={context.source?.pageId} title={context.source?.title ?? uiText("未找到主页面")} onLocate={a.locatePage}/>
  </>
}
function TabsBody({ slot }: ContainerProps) { return <SurfaceSlot className="tool-view-slot" slot={slot}/> }
function ContextBody({ snapshot, slot }: ContainerProps) {
  useUiLocale()
  const context = snapshot.context!
  return <div className="tool-view-slot context-tool-body">
    {!context.items.length && <div className="context-tool-empty" role="status">{context.emptyReason}</div>}
    <SurfaceSlot className="context-tool-slot" slot={slot} id={contextPanelId(snapshot.id)} role="tabpanel" aria-label={context.items.find(t => t.id === context.active)?.title ?? uiText("当前页面工具")}/>
  </div>
}

/** 内部固定装配表，不是插件注册表。业务来源策略与关闭协议仍由宿主投影和动作负责。 */
const definitions: Record<SidebarContainerSnapshot['type'], SidebarContainerDefinition> = {
  tabs: { regions: ['left', 'right'], source: 'members', Header: TabsHeader, Body: TabsBody },
  context: { regions: ['left', 'right'], source: 'page-context', Header: ContextHeader, Body: ContextBody }
}
export function resolveSidebarContainer(snapshot: SidebarContainerSnapshot): SidebarContainerDefinition {
  const definition = Object.hasOwn(definitions, snapshot.type) ? definitions[snapshot.type] : undefined
  if (!definition || !definition.regions.includes(snapshot.side)) throw new Error(uiText("侧栏容器不能装配到此区域：{id}", { id: String(snapshot.id) }))
  if ((definition.source === 'page-context') !== !!snapshot.context) throw new Error(uiText("侧栏容器的内容来源不匹配：{id}", { id: String(snapshot.id) }))
  return definition
}
export function sidebarContainerSlot(type: SidebarContainerSnapshot['type'], id: string) {
  return surfaceSlot(definitions[type].source === 'members' ? 'sidebar' : 'context', id)
}
