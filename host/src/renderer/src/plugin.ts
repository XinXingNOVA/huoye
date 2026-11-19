// 宿主内部兼容入口。插件使用 src/plugin-api/ui 下明确的模块。
export type * from '../../plugin-api/ui/contracts'
export { useEntity, useGone, useKinds } from '../../plugin-api/ui/data'
export { useNeighbors, type Neighbors } from '../../plugin-api/ui/navigation'
export { useKeys } from '../../plugin-api/ui/hooks'
export { overlaysFor } from './ui-registry'
export { Marked, markTermsIn, useSearch, useSearchText } from '../../plugin-api/ui/search'
export { Embed } from '../../plugin-api/ui/media'
