export type { ContextTool } from './context-tools'
import { CollectionFilters } from './components/CollectionFilters'
import { toolViews, defaultToolGroups } from './ui-registry'

export type { ShellContainer, ShellView, SidebarCatalog } from './sidebar-types'
import type { SidebarCatalog } from './sidebar-types'
export function sidebarCatalog(): SidebarCatalog {
  return {
    containers: [
      { id: 'host.navigation', title: '导航', side: 'left' },
      { id: 'host.inspector', title: '详情', side: 'right' },
      ...defaultToolGroups()
    ],
    views: [
      { id: 'host.navigation', title: '导航', container: 'host.navigation', placement: { regions: ['left', 'center', 'right'] } },
      { id: 'host.inspector', title: '详情', container: 'host.inspector' },
      ...toolViews().filter(v => !v.context)
    ],
    contextTools: [
      { id: 'host.filters', title: '筛选', order: 0, placement: { regions: ['left', 'center', 'right'] }, context: { requires: ['collection.filter'], detachable: { maxInstances: 8 } }, Component: CollectionFilters },
      ...toolViews().filter((v): v is typeof v & { context: NonNullable<typeof v.context> } => !!v.context)
    ]
  }
}
