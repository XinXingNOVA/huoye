import type { PageContext } from '../../plugin-api/ui/contracts'
import type { SidebarCatalog } from './sidebar-types'
import { contextToolsFor } from './context-tools'
import { closeDockTool, reconcileToolWorkspace } from './tool-docking'
import { describeTools } from './workbench-content'
import { addContextContainer, availableContainers, closeView, moveContainer, moveView, reconcileSidebars, removeBoundTool, resetView, revealContextContainer, revealView, sidebarMinHeight, type SidebarLayout, type SidebarSide } from './sidebar-layout'
import { toolIdOf, type Workspace } from './workspace'

export type ContextTarget = Readonly<Pick<PageContext, 'pageId' | 'type'>>
export type ContextChange = { type: 'select' | 'toggle' | 'hide'; tool: string } | { type: 'reorder'; tool: string; direction: -1 | 1 } | { type: 'reset' }
export type ContainerAction =
  | { type: 'show-tool' | 'close-tool' | 'reset-tool'; id: string }
  | { type: 'reorder-tool'; id: string; group: string; direction: -1 | 1 }
  | { type: 'close-group'; id: string }
  | { type: 'reorder-group'; id: string; direction: -1 | 1 }
  | { type: 'add-context'; side: SidebarSide }
  | { type: 'context'; id: string; source: ContextTarget; change: ContextChange }
  | { type: 'resize-groups'; first: string; second: string; ratio: number }
  | { type: 'set-visible'; side: SidebarSide; visible: boolean }
  | { type: 'resize-region'; side: SidebarSide; size: number }
  | { type: 'reset-sidebars' }
export interface ContainerActionResult { workspace: Workspace; blocked?: string; focus?: string }

/** 明确动作作用于提交时快照；拒绝返回原对象。页面关闭仍由页面生命周期处理。 */
export function applyContainerAction(w: Workspace, catalog: SidebarCatalog, action: ContainerAction, env: { context?: PageContext; height?: number } = {}): ContainerActionResult {
  const layout = w.sidebars!, tools = describeTools(w, catalog)
  const reject = (blocked: string): ContainerActionResult => ({ workspace: w, blocked })
  const finish = (sidebars: SidebarLayout, side?: SidebarSide): ContainerActionResult => ({ workspace: reconcileToolWorkspace({ ...w, sidebars,
    panels: side ? { ...w.panels, [side === 'left' ? 'sidebar' : 'inspector']: true } : w.panels }, catalog) })
  switch (action.type) {
    case 'show-tool': {
      if (action.id === 'host.context' || catalog.contextTools.some(t => t.id === action.id)) {
        let sidebars = revealContextContainer(layout)
        const group = sidebars.containers.find(c => c.type === 'context' && !c.closed)!
        if (action.id !== 'host.context') {
          const source = env.context, resolved = contextToolsFor(catalog.contextTools, source, source && group.contexts?.[source.type])
          if (!source?.isAvailable() || !resolved.candidates.some(t => t.id === action.id)) return reject('当前页面不适用此工具')
          sidebars = { ...sidebars, containers: sidebars.containers.map(c => c.id === group.id ? { ...c, contexts: { ...c.contexts,
            [source.type]: { tools: resolved.order.includes(action.id) ? [...resolved.order] : [...resolved.order, action.id], active: action.id } } } : c) }
        }
        return finish(sidebars, group.side)
      }
      const page = w.tabs.find(t => toolIdOf(t) === action.id)
      if (page) return { workspace: w, focus: page.id }
      const group = layout.containers.find(c => c.views.includes(action.id))
      if (!group || !tools.some(t => t.id === action.id)) return reject('工具暂不可用')
      return finish(revealView(layout, action.id), group.side)
    }
    case 'close-tool': return layout.containers.some(c => c.views.includes(action.id)) || w.tabs.some(t => toolIdOf(t) === action.id)
      ? { workspace: closeDockTool(w, action.id, catalog) } : reject('工具已关闭')
    case 'reset-tool': {
      if (layout.bindings?.[action.id] || !catalog.views.some(t => t.id === action.id) || !layout.containers.some(c => c.views.includes(action.id))) return reject('此工具无法恢复默认位置')
      const next = resetView(layout, action.id, catalog.containers, catalog.views)
      return finish(next, next.containers.find(c => c.views.includes(action.id))?.side)
    }
    case 'reorder-tool': {
      const c = layout.containers.find(c => c.id === action.group && c.type === 'tabs' && c.views.includes(action.id))
      if (!c) return reject('工具位置已改变')
      const at = c.views.indexOf(action.id), adjacent = at + action.direction
      return adjacent < 0 || adjacent >= c.views.length ? { workspace: w } : finish(moveView(layout, action.id, c.id, c.views[at + (action.direction === -1 ? -1 : 2)]))
    }
    case 'close-group': {
      const c = layout.containers.find(c => c.id === action.id)
      if (!c) return reject('工具组已关闭')
      return finish(c.type === 'context' ? { ...layout, containers: layout.containers.map(g => g.id === c.id ? { ...g, closed: true } : g) }
        : c.views.reduce((next, id) => next.bindings?.[id] ? removeBoundTool(next, id) : closeView(next, id), layout))
    }
    case 'reorder-group': {
      const c = layout.containers.find(c => c.id === action.id)
      if (!c) return reject('工具组已关闭')
      const groups = availableContainers(layout, tools, c.side), at = groups.findIndex(g => g.id === c.id), adjacent = at + action.direction
      return at < 0 ? reject('工具组已关闭') : adjacent < 0 || adjacent >= groups.length ? { workspace: w }
        : finish(moveContainer(layout, c.id, c.side, groups[at + (action.direction === -1 ? -1 : 2)]?.id))
    }
    case 'add-context': {
      const groups = availableContainers(layout, tools, action.side)
      if (groups.reduce((sum, c) => sum + sidebarMinHeight(c), 0) + 190 > (env.height ?? 0)) return reject('侧栏空间不足，可先合并或关闭一个分组')
      return finish(addContextContainer(layout, action.side), action.side)
    }
    case 'context': {
      const c = layout.containers.find(c => c.id === action.id && c.type === 'context' && !c.closed), source = env.context
      if (!c) return reject('工具组已关闭')
      if (!source?.isAvailable() || source.pageId !== action.source.pageId || source.type !== action.source.type) return reject('来源页面已关闭或已改变')
      const change = action.change, resolved = contextToolsFor(catalog.contextTools, source, c.contexts?.[source.type])
      const contexts = { ...c.contexts }
      if (change.type === 'reset') delete contexts[source.type]
      else {
        if (!resolved.candidates.some(t => t.id === change.tool)) return reject('此工具不再适用于来源页面')
        const order = [...resolved.order], at = order.indexOf(change.tool)
        if (change.type === 'select') {
          if (at < 0) return reject('此工具已隐藏')
          contexts[source.type] = { tools: order, active: change.tool }
        } else {
          if (change.type === 'toggle') { if (at >= 0) order.splice(at, 1); else order.push(change.tool) }
          else if (change.type === 'hide') { if (at >= 0) order.splice(at, 1) }
          else if (change.type === 'reorder' && at >= 0 && at + change.direction >= 0 && at + change.direction < order.length) { order.splice(at, 1); order.splice(at + change.direction, 0, change.tool) }
          contexts[source.type] = { tools: order, active: resolved.active }
        }
      }
      return finish({ ...layout, containers: layout.containers.map(g => g.id === c.id ? { ...g, contexts } : g) })
    }
    case 'resize-groups': {
      const a = layout.containers.find(c => c.id === action.first), b = layout.containers.find(c => c.id === action.second)
      const groups = a && availableContainers(layout, tools, a.side), at = groups?.findIndex(c => c.id === a?.id) ?? -1
      if (!a || !b || at < 0 || groups?.[at + 1]?.id !== b.id) return reject('分组位置已改变')
      if (!Number.isFinite(action.ratio)) return reject('无效的分组比例')
      const ratio = Math.min(.9, Math.max(.1, action.ratio)), total = (layout.weights[a.id] ?? 1) + (layout.weights[b.id] ?? 1)
      return finish({ ...layout, weights: { ...layout.weights, [a.id]: total * ratio, [b.id]: total * (1 - ratio) } })
    }
    case 'set-visible': return { workspace: { ...w, panels: { ...w.panels, [action.side === 'left' ? 'sidebar' : 'inspector']: action.visible } } }
    case 'resize-region': return !Number.isFinite(action.size) || action.size <= 0 ? reject('无效的侧栏宽度')
      : { workspace: { ...w, panelSizes: { ...w.panelSizes, [action.side === 'left' ? 'sidebar' : 'inspector']: action.size } } }
    case 'reset-sidebars': {
      const bindings = Object.fromEntries(w.tabs.flatMap(t => { const id = toolIdOf(t), binding = id && layout.bindings?.[id]; return binding ? [[id, binding]] : [] }))
      const sidebars = { ...reconcileSidebars(undefined, catalog.containers, catalog.views), ...(Object.keys(bindings).length ? { bindings } : {}) }
      return { workspace: reconcileToolWorkspace({ ...w, sidebars, panels: { ...w.panels, sidebar: true, inspector: true }, panelSizes: { ...w.panelSizes, sidebar: 220, inspector: 300 } }, catalog) }
    }
  }
}
