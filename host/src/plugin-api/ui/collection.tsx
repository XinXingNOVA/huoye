import type { FC, ReactNode } from 'react'
import type { Query } from '../../shared/query'
import type { CollectionParams, CollectionState } from '../../shared/collection'
import type { TabProps, UiHost } from './contracts'
import type { NavigationList } from './navigation'
import { useUiRuntime } from './internal/runtime'

export type { CollectionParams, CollectionState, CollectionQueryState } from '../../shared/collection'
export { collectionQuery } from '../../shared/collection'
export interface CollectionToolbarProps {
  host: UiHost
  ids: readonly string[]
  selected: readonly string[]
  query: Query
}
/** 声明 collection-surface-v1。每个标签页嵌入一个集合，沿用 TabProps 的状态／焦点协议。 */
export interface ResourceCollectionProps extends TabProps<CollectionParams, CollectionState> {
  /** 运行时动态范围。更新时传新数组；加载中用 []，undefined 表示不限。 */
  scopeIds?: readonly string[]
  Toolbar?: FC<CollectionToolbarProps>
  /** 列表上方的业务提示／恢复入口，不写入页面存档。 */
  beforeItems?: ReactNode
  /** 默认按宿主打开方式阅读；可改为继续编辑等业务动作。 */
  onOpen?(id: string, from: NavigationList): void
}
export function ResourceCollection(props: ResourceCollectionProps) {
  const { Collection } = useUiRuntime().components
  return <Collection {...props} />
}
