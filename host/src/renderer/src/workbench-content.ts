import type { FC } from 'react'
import type { TabType, ToolViewProps } from '../../plugin-api/ui/contracts'
import type { BoundTool } from '../../shared/sidebar-layout'
import type { SidebarCatalog, ShellView } from './sidebar-types'
import { toolIdOf, type TabEntry, type Workspace } from './workspace'

export type WorkbenchRegion = 'left' | 'center' | 'right'
interface ContentDescription {
  id: string
  typeId: string
  title: string
  regions: readonly WorkbenchRegion[]
}
/** 描述用于装配，不统一页面和工具的 active／关闭／存档协议。动态 Title 保留原组件身份。 */
export interface PageContent extends ContentDescription {
  kind: 'page'
  entry: TabEntry
  definition?: TabType
}
export interface ToolContent extends ContentDescription {
  kind: 'tool'
  available: boolean
  Icon?: FC
  dropQuery?: import('../../plugin-api/ui/contracts').ToolViewContribution['dropQuery']
  Component?: FC<ToolViewProps>
  defaultPlacement?: { region: 'left' | 'right'; group: string }
  binding?: BoundTool
}
export type WorkbenchContent = PageContent | ToolContent
const sideRegions = ['left', 'right'] as const
export const toolRegions = (tool: Pick<ShellView, 'placement'>): readonly WorkbenchRegion[] => tool.placement?.regions ?? sideRegions
export function describePage(entry: TabEntry, definition: TabType | undefined): PageContent {
  return { kind: 'page', id: entry.id, typeId: entry.type, title: entry.type, regions: ['center'], entry, definition }
}
/** 声明边界已将新旧写法归一为内部默认分组；描述不携带可写的实际位置。 */
export function describeTools(w: Workspace, catalog: SidebarCatalog): ToolContent[] {
  const tools: ToolContent[] = catalog.views.map(v => {
    const group = catalog.containers.find(c => c.id === v.container)
    return { kind: 'tool', id: v.id, typeId: v.id, title: v.title, Icon: v.Icon, Component: v.Component, dropQuery: v.dropQuery, available: true,
      regions: toolRegions(v), ...(group ? { defaultPlacement: { region: group.side, group: group.id } } : {}) }
  })
  for (const [id, binding] of Object.entries(w.sidebars?.bindings ?? {})) {
    const tool = catalog.contextTools.find(t => t.id === binding.toolId)
    tools.push({ kind: 'tool', id, typeId: binding.toolId, title: `${tool?.title ?? binding.title} · ${binding.pageTitle}`, Icon: tool?.Icon,
      regions: tool ? toolRegions(tool) : sideRegions, available: !!tool, binding })
  }
  // 缺失插件的中央工具仍可移回侧栏／关闭；不虚构中央适配能力。
  for (const t of w.tabs) {
    const id = toolIdOf(t)
    if (id && !tools.some(v => v.id === id)) tools.push({ kind: 'tool', id, typeId: id, title: String(t.params.title ?? id), regions: sideRegions, available: false })
  }
  return tools
}
export function describeTab(entry: TabEntry, tools: ToolContent[], definition: TabType | undefined): WorkbenchContent {
  const id = toolIdOf(entry)
  return tools.find(t => t.id === id) ?? describePage(entry, definition)
}
export function contentPlacementReason(content: Pick<WorkbenchContent, 'kind' | 'regions'> | undefined, region: WorkbenchRegion): string | undefined {
  if (!content) return '工具暂不可用'
  if (!content.regions.includes(region)) return `此${content.kind === 'page' ? '页面' : '工具'}不支持放到${{ left: '左侧栏', center: '主工作区', right: '右侧栏' }[region]}`
}
