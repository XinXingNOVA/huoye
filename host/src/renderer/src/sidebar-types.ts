import type { FC } from 'react'
import type { ToolViewProps } from '../../plugin-api/ui/contracts'
import type { ContextTool } from './context-tools'
import type { ContainerDefault, ViewDefault } from './sidebar-layout'

export interface ShellContainer extends ContainerDefault { title: string; Icon?: FC }
export interface ShellView extends ViewDefault {
  title: string
  placement?: import('../../plugin-api/ui/contracts').ToolViewContribution['placement']
  Icon?: FC
  dropQuery?: import('../../plugin-api/ui/contracts').ToolViewContribution['dropQuery']
  Component?: FC<ToolViewProps>
}
export interface SidebarCatalog { containers: ShellContainer[]; views: ShellView[]; contextTools: ContextTool[] }
