import type { PageContext } from '../../plugin-api/ui/contracts'
import type { SidebarCatalog } from './sidebar-types'
import type { Workspace } from './workspace'
import { toolIdOf } from './workspace'
import { canSplitEditor, editorsOf, groupOf, type EditorEdge, type EditorRect } from './editor-layout'
import { chooseBoundTool, findBoundTool } from './context-tools'
import { availableContainers, groupViews, mergeContainers, moveContainer, placeBoundTool, sidebarMinHeight, type SidebarSide } from './sidebar-layout'
import { contentPlacementReason, describeTools, toolRegions, type WorkbenchRegion } from './workbench-content'
import { dockToolCenter, dockToolSide } from './tool-docking'

export type DockSource = { type: 'view' | 'container'; id: string } | { type: 'context-tool'; id: string; pageId: string; containerId: string }
export type DockTarget =
  | { region: 'center'; group?: string; edge?: EditorEdge; before?: string }
  /** group 无 edge 时加入组，before 为工具；有 edge 时在组旁独立放置；无 group 时 before 为容器。 */
  | { region: SidebarSide; group?: string; edge?: 'top' | 'bottom'; before?: string }
export interface PlacementSpace { sideHeight?: number; editorRect?: EditorRect }
type Destination = { region: 'center'; group: string; edge?: EditorEdge; before?: string } | { region: SidebarSide; group?: string; before?: string }
type Placement = { destination: Destination; existing?: string; blocked?: never } | { blocked: string; destination?: never; existing?: never }

/** 来源校验与实例选择共用一次决策；落点解析接续该身份，不另写一套去重规则。 */
function resolveDockSource(w: Workspace, catalog: SidebarCatalog, value: DockSource, region: WorkbenchRegion, context?: PageContext): { existing?: string; blocked?: string } {
  const tools = describeTools(w, catalog)
  if (value.type === 'container') {
    const c = w.sidebars!.containers.find(c => c.id === value.id)
    if (!c) return { blocked: '工具组已关闭' }
    if (region === 'center') return { blocked: '整组暂时仅在侧栏移动，请拖动具体工具标签' }
    return { blocked: c.views.map(id => contentPlacementReason(tools.find(t => t.id === id), region)).find(Boolean) }
  }
  if (value.type === 'context-tool') {
    const tool = catalog.contextTools.find(t => t.id === value.id)
    if (!w.sidebars!.containers.some(c => c.id === value.containerId && c.type === 'context' && !c.closed)) return { blocked: '来源工具组已关闭' }
    if (context && context.pageId !== value.pageId) return { blocked: '来源页面已关闭或不再适用' }
    const choice = chooseBoundTool(w.sidebars!, tool, context)
    return { ...choice, blocked: choice.blocked ?? contentPlacementReason(tool && { kind: 'tool', regions: toolRegions(tool) }, region) }
  }
  // 普通／已固定工具按实例 ID 移动，不再申请名额，也不把中央位置标签算成第二份。
  return { existing: value.id, blocked: contentPlacementReason(tools.find(t => t.id === value.id), region) }
}
/** 只检查来源与区域能力，供菜单列举可用区域；具体落点仍须 resolveToolPlacement 校验。 */
export function dockSourceReason(w: Workspace, catalog: SidebarCatalog, value: DockSource, region: WorkbenchRegion, context?: PageContext): string | undefined {
  return resolveDockSource(w, catalog, value, region, context).blocked
}

/** 预览与提交共用的纯解析：不创建实例、不修改工作区、不读取 DOM。 */
export function resolveToolPlacement(w: Workspace, catalog: SidebarCatalog, value: DockSource, target: DockTarget, context?: PageContext, space: PlacementSpace = {}): Placement {
  const { blocked, existing } = resolveDockSource(w, catalog, value, target.region, context)
  if (blocked) return { blocked }
  if (target.region === 'center') {
    const group = target.group ?? groupOf(w)!.id
    if (!editorsOf(w).groups.some(g => g.id === group)) return { blocked: '目标内容区域已关闭' }
    const tab = existing ? w.tabs.find(t => toolIdOf(t) === existing) : undefined
    const source = tab && groupOf(w, tab.id)
    if (target.edge && source?.id === group && source.tabs.length === 1) return { blocked: '空间不足或无需拆分' }
    if (target.edge && (!space.editorRect || !canSplitEditor(space.editorRect, target.edge))) return { blocked: '区域空间不足，可先调整区域大小' }
    return { destination: { ...target, group }, existing }
  }
  const layout = w.sidebars!, tools = describeTools(w, catalog), groups = availableContainers(layout, tools, target.region)
  const source = layout.containers.find(c => value.type === 'container' ? c.id === value.id : c.views.includes(existing ?? value.id))
  const group = target.group ? groups.find(c => c.id === target.group) : undefined
  if (target.group && !group) return { blocked: '目标工具组已关闭' }
  if (target.edge && source && source.id === group?.id && (value.type === 'container' || groupViews(layout, source, tools).length === 1)) return { blocked: '已独立成组，无需拆分' }
  if (group && !target.edge) {
    if (source?.type === 'context' || group.type === 'context') return { blocked: '智能组通过配置选择工具，请拖到上方或下方移动分区' }
    return { destination: { region: target.region, group: group.id, before: target.before }, existing }
  }
  const before = group ? target.edge === 'top' ? group.id : groups[groups.indexOf(group) + 1]?.id : target.before
  const capacityReason = separateReason(w, catalog, value, target.region, space.sideHeight ?? Infinity, existing)
  return capacityReason ? { blocked: capacityReason } : { destination: { region: target.region, before }, existing }
}

function separateReason(w: Workspace, catalog: SidebarCatalog, value: DockSource, side: SidebarSide, height: number, existing?: string): string | undefined {
  const layout = w.sidebars!, tools = describeTools(w, catalog), groups = availableContainers(layout, tools, side)
  if (value.type === 'context-tool') {
    if (existing) return separateReason(w, catalog, { type: 'view', id: existing }, side, height)
    if (groups.reduce((sum, c) => sum + sidebarMinHeight(c), 0) + 120 > height) return '空间不足，可先合并或关闭一个分组'
    return
  }
  const source = layout.containers.find(c => value.type === 'container' ? c.id === value.id : c.views.includes(value.id))
  if (!source && !w.tabs.some(t => toolIdOf(t) === value.id)) return '原工具已关闭'
  const addsGroup = !groups.some(g => g.id === source?.id) || value.type === 'view' && !!source && groupViews(layout, source, tools).some(id => id !== value.id)
  if (addsGroup && groups.reduce((sum, c) => sum + sidebarMinHeight(c), 0) + (value.type === 'container' ? sidebarMinHeight(source!) : 120) > height) return '空间不足，可先合并或关闭一个分组'
}

/** 必须用提交时快照重新解析；失败不创建固定身份，不留下半次移动。 */
export function placeToolContent(w: Workspace, catalog: SidebarCatalog, value: DockSource, target: DockTarget, context?: PageContext, space: PlacementSpace = {}): Workspace {
  const resolved = resolveToolPlacement(w, catalog, value, target, context, space)
  if (resolved.blocked) return w
  const to = resolved.destination!
  if (value.type === 'container') {
    if (to.region === 'center') return w
    const sidebars = to.group ? mergeContainers(w.sidebars!, value.id, to.group, to.before) : moveContainer(w.sidebars!, value.id, to.region, to.before)
    return { ...w, sidebars, panels: { ...w.panels, [to.region === 'left' ? 'sidebar' : 'inspector']: true } }
  }
  let ready = w, id = value.id
  if (value.type === 'context-tool') {
    const tool = catalog.contextTools.find(t => t.id === value.id)!
    if (resolved.existing) id = resolved.existing
    else {
      const binding = { toolId: tool.id, pageId: context!.pageId, pageType: context!.type, title: tool.title.slice(0, 1000), pageTitle: context!.title.slice(0, 1000) }
      const sidebars = placeBoundTool(w.sidebars!, binding, 'left')
      id = findBoundTool(sidebars, binding)!
      ready = { ...w, sidebars }
    }
  }
  return to.region === 'center'
    ? dockToolCenter(ready, id, describeTools(ready, catalog).find(t => t.id === id)!.title, to.group, to.edge, to.before)
    : dockToolSide(ready, id, to.region, to.group, to.before)
}
