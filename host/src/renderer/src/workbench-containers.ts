import { uiText } from '../../shared/i18n/interface-display'
import type { PageContext } from '../../plugin-api/ui/contracts'
import type { SidebarCatalog } from './sidebar-types'
import type { SidebarSide } from './sidebar-layout'
import { activeView, groupViews } from './sidebar-layout'
import { contextToolsFor, type ContextTool } from './context-tools'
import { describeTools, toolRegions, type ToolContent, type WorkbenchRegion } from './workbench-content'
import { toolIdOf, type Workspace } from './workspace'

export type ContainerTool = Readonly<Omit<ToolContent, 'binding' | 'Component'>> & {
  readonly binding?: Readonly<NonNullable<ToolContent['binding']>>
  readonly pageId?: string
  /** 头部短名称与来源分开，完整 title 继续用于菜单及可访问名称。 */
  readonly label: string
  readonly source?: { readonly id: string; readonly title: string; readonly available: boolean }
}
/** 容器只得到可呈现的信息；组件和运行时能力留给宿主实例承载层。 */
export interface ContextToolChoice {
  readonly id: string
  readonly title: string
  readonly Icon?: ContextTool['Icon']
  readonly regions: readonly WorkbenchRegion[]
  readonly detachable: boolean
}
export interface ContextContainerSnapshot {
  readonly source?: Readonly<Pick<PageContext, 'pageId' | 'type' | 'title'>>
  readonly candidates: readonly ContextToolChoice[]
  readonly order: readonly string[]
  readonly items: readonly ContextToolChoice[]
  readonly active?: string
  readonly emptyReason: string
}
/** 独立于容器外壳的宿主运行记录；不作为外壳 props，不进入存档。 */
export interface ContextToolInstance {
  readonly key: string
  readonly groupId: string
  readonly source: PageContext
  readonly tool: ContextTool
  readonly visible: boolean
}
export interface SidebarContainerSnapshot {
  readonly id: string
  readonly type: 'tabs' | 'context'
  readonly side: SidebarSide
  readonly title: string
  readonly members: readonly string[]
  readonly items: readonly ContainerTool[]
  readonly active?: string
  readonly weight: number
  /** present 决定是否占据布局；visible 再考虑区域开合，不代表中央操作焦点。 */
  readonly present: boolean
  readonly visible: boolean
  readonly context?: ContextContainerSnapshot
}
export interface SidebarSnapshot {
  readonly tools: readonly ContainerTool[]
  readonly contextInstances: readonly ContextToolInstance[]
  readonly groups: readonly SidebarContainerSnapshot[]
  readonly regions: Readonly<Record<SidebarSide, { readonly visible: boolean; readonly hasUnavailable: boolean }>>
}

/** 只投影，不返回可写的布局、偏好或成员数组；组件和能力对象仍沿用原引用。 */
export function describeSidebarContainers(w: Workspace, catalog: SidebarCatalog, contexts: readonly PageContext[]): SidebarSnapshot {
  const layout = w.sidebars!
  const tools: ContainerTool[] = describeTools(w, catalog).map(({ Component: _, ...tool }) => {
    const binding = tool.binding
    return { ...tool,
      label: binding ? catalog.contextTools.find(t => t.id === tool.typeId)?.title ?? binding.title : tool.title,
      binding: binding && { ...binding }, pageId: w.tabs.find(p => toolIdOf(p) === tool.id)?.id,
      source: binding && {
        id: binding.pageId, title: contexts.find(c => c.pageId === binding.pageId)?.title ?? binding.pageTitle,
        available: w.tabs.some(p => p.id === binding.pageId)
      }
    }
  })
  const source = contexts.find(c => c.pageId === w.active)
  const regions = Object.fromEntries((['left', 'right'] as const).map(side => [side, {
    visible: w.panels[side === 'left' ? 'sidebar' : 'inspector'],
    hasUnavailable: layout.containers.some(c => c.side === side && c.views.some(id => !catalog.views.some(v => v.id === id)))
  }])) as SidebarSnapshot['regions']
  const contextInstances: ContextToolInstance[] = []
  const choice = (t: ContextTool): ContextToolChoice => ({ id: t.id, title: t.title, Icon: t.Icon, regions: [...toolRegions(t)], detachable: !!t.context.detachable })
  const groups = layout.containers.map(c => {
    const items = groupViews(layout, c, tools).map(id => tools.find(t => t.id === id)!), present = c.type === 'context' ? !c.closed : !!items.length
    const visible = present && regions[c.side].visible
    const resolved = c.type === 'context' ? contextToolsFor(catalog.contextTools, source, source && c.contexts?.[source.type]) : undefined
    if (resolved) for (const page of contexts) for (const tool of catalog.contextTools) {
      if (tool.context.requires.every(k => page.capabilities[k] != null)) contextInstances.push({
        key: JSON.stringify([c.id, page.pageId, tool.id]), groupId: c.id, source: page, tool,
        visible: visible && page.pageId === source?.pageId && tool.id === resolved.active
      })
    }
    return { id: c.id, type: c.type, side: c.side, title: c.type === 'context' ? uiText("当前页面工具") : c.views.map(id => tools.find(t => t.id === id)?.title ?? id).join(' / '),
      members: [...c.views], items, active: activeView(layout, c, tools), weight: layout.weights[c.id] ?? 1, present, visible,
      context: resolved && { source: source && { pageId: source.pageId, type: source.type, title: source.title },
        candidates: resolved.candidates.map(choice), order: [...resolved.order], items: resolved.visible.map(choice), active: resolved.active,
        emptyReason: resolved.candidates.length ? uiText("此类页面未显示工具") : uiText("当前页面暂无适用工具") }
    }
  })
  return { tools, groups, regions, contextInstances }
}
