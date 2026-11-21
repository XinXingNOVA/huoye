import { useLanguage, viewTitle } from '../language'
import { collectionWorkbench } from '../page-workbench'
import { presetViews, layoutList } from '../ui-registry'
import type { TabType } from '../plugin'
import { CollectionSurface } from '../components/ResourceCollection'
import { collectionQuery, type CollectionParams, type CollectionState } from '../../../plugin-api/ui/collection'
export type { CollectionState } from '../../../plugin-api/ui/collection'
export { collectionQuery as effectiveQuery } from '../../../shared/collection'
export { ruleLabel as condLabel } from '../query-labels'

export const collectionTabType: TabType<CollectionParams, CollectionState> = {
  workbench: collectionWorkbench(() => presetViews, () => layoutList),
  id: 'collection', Title: function CollectionTitle({ params }) { useLanguage(); return <>{viewTitle(params.presetId, params.title)}</> },
  Component: props => <CollectionSurface {...props} savedViews />,
  dropQuery: collectionQuery
}
