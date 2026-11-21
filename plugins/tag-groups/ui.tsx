import { pluginMessages as packageMessages } from '@resource-manager/plugin-api/ui/locale'
import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { GroupedTags } from './groups'

const uiText = packageMessages('tag-groups')

export const plugin: UiPlugin = {
  id: 'tag-groups',
  facets: [{ id: 'tag-groups.facet', get title() { return uiText("标签分组") }, kind: 'tags', field: 'values', order: 10, Component: GroupedTags }]
}
