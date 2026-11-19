import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { GroupedTags } from './groups'
export const plugin: UiPlugin = {
  id: 'tag-groups',
  facets: [{ id: 'tag-groups.facet', title: '标签分组', kind: 'tags', field: 'values', order: 10, Component: GroupedTags }]
}
