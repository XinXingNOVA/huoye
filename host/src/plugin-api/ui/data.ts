import { useCallback, useSyncExternalStore } from 'react'
import { useUiRuntime } from './internal/runtime'
import type { EntityState } from './entities'
export type { EntityState } from './entities'

const idle: EntityState = { status: 'idle' }
const noop = () => {}

/** 按身份订阅；空 ID 不请求，卸载解除订阅。请求合并、失效与迟到响应由宿主管理。 */
export function useEntityState(id: string | undefined): EntityState {
  const { entities } = useUiRuntime()
  const subscribe = useCallback((listener: () => void) => id ? entities.subscribe(id, listener) : noop, [entities, id])
  const snapshot = useCallback(() => id ? entities.getSnapshot(id) : idle, [entities, id])
  return useSyncExternalStore(subscribe, snapshot)
}

/** 简单读取：未加载、已不存在或首次读取失败时为 undefined。需要区分时使用 useEntityState。 */
export const useEntity = (id: string | undefined) => useEntityState(id).view
export const useGone = (id: string | undefined) => useEntityState(id).status === 'missing'

/** 静态、动态和休眠定义；模板变化自动更新，插件不得修改返回的定义对象。 */
export function useKinds() {
  const { definitions } = useUiRuntime()
  return useSyncExternalStore(definitions.subscribe, definitions.all)
}
