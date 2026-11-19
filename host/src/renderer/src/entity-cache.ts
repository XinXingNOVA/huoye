// 宿主私有注入入口；插件通过公共 data hooks 订阅，不取得缓存实例。
import { createContext } from 'react'
import { EntityCache } from './entity-store'
export { EntityCache }
export const CacheContext = createContext<EntityCache | null>(null)
export { useEntity, useGone } from '../../plugin-api/ui/data'
