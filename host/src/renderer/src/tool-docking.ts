import type { SidebarCatalog } from './sidebar-types'
import { describeTools } from './workbench-content'
import { closeEditor, editorsOf, insertEditor, moveEditor, splitEditors, splitMoveEditor } from './editor-layout'
import type { EditorEdge } from './editor-layout'
import { closeView, putToolInSidebar, reconcileSidebars, removeBoundTool, takeToolFromSidebar } from './sidebar-layout'
import type { SidebarSide } from './sidebar-layout'
import { startTab, toolIdOf, toolTab, type Workspace } from './workspace'

/** 与侧栏补默认入口共用的工作区边界：中心位置优先，固定身份没有位置时才回收。 */
export function reconcileToolWorkspace(w: Workspace, catalog: SidebarCatalog): Workspace {
  const centered = new Set(w.tabs.flatMap(t => toolIdOf(t) ?? []))
  let sidebars = reconcileSidebars(w.sidebars, catalog.containers, catalog.views.filter(v => !centered.has(v.id)), w.docks)
  for (const id of centered) sidebars = takeToolFromSidebar(sidebars, id)
  for (const id of Object.keys(sidebars.bindings ?? {})) if (!centered.has(id) && !sidebars.containers.some(c => c.views.includes(id))) sidebars = removeBoundTool(sidebars, id)
  return { ...w, sidebars }
}
export function dockToolCenter(w: Workspace, id: string, title: string, target: string, edge?: EditorEdge, before?: string): Workspace {
  if (!editorsOf(w).groups.some(g => g.id === target)) return w
  const tab = w.tabs.find(t => toolIdOf(t) === id)
  let next: Workspace
  if (tab) next = edge ? splitMoveEditor(w, tab.id, target, edge, startTab()) : moveEditor(w, tab.id, target, before)
  else next = edge ? splitEditors(w, edge, toolTab(id, title), target) : insertEditor(w, toolTab(id, title), target)
  if (!tab && !edge && before) next = moveEditor(next, toolTab(id, title).id, target, before)
  return next === w ? w : { ...next, sidebars: takeToolFromSidebar(next.sidebars!, id) }
}
export function dockToolSide(w: Workspace, id: string, side: SidebarSide, target?: string, before?: string): Workspace {
  const sidebars = putToolInSidebar(w.sidebars!, id, side, target, before)
  if (!sidebars.containers.some(c => c.views.includes(id) && c.side === side)) return w
  const tab = w.tabs.find(t => toolIdOf(t) === id)
  const next = tab ? closeEditor(w, tab.id, startTab()) : w
  return { ...next, sidebars, panels: { ...next.panels, [side === 'left' ? 'sidebar' : 'inspector']: true } }
}
/** 普通实例关闭后保留运行状态、回默认侧栏待重开；固定实例关闭才释放绑定。 */
export function closeDockTool(w: Workspace, id: string, catalog: SidebarCatalog): Workspace {
  const tab = w.tabs.find(t => toolIdOf(t) === id)
  let next = tab ? closeEditor(w, tab.id, startTab()) : w
  if (next.sidebars?.bindings?.[id]) return { ...next, sidebars: removeBoundTool(next.sidebars, id) }
  const placement = describeTools(w, catalog).find(v => v.id === id)?.defaultPlacement
  if (tab && placement) next = { ...next, sidebars: putToolInSidebar(next.sidebars!, id, placement.region, next.sidebars!.containers.some(c => c.id === placement.group && c.type === 'tabs') ? placement.group : undefined) }
  return { ...next, sidebars: closeView(next.sidebars!, id) }
}
