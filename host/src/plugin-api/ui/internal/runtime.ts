// 宿主注入点，不是插件可导入的入口。这里不认识注册表、插件清单或窗口实现。
import { createContext, useContext, type FC } from 'react'
import type { BlockKind } from '../../../shared/blocks'
import type { EntitySource } from '../entities'
import type { ResourceCollectionProps } from '../collection'
import type { ResourceCardProps, ResourceCoverProps, EmbedProps } from '../media'

export interface UiRuntime {
  openExternal(url: string): void
  entities: EntitySource
  definitions: {
    all(): BlockKind[]
    subscribe(listener: () => void): () => void
  }
  components: {
    Collection: FC<ResourceCollectionProps>
    Card: FC<ResourceCardProps>
    Cover: FC<ResourceCoverProps>
    Embed: FC<EmbedProps>
  }
}
export const UiRuntimeContext = createContext<UiRuntime | null>(null)
export function useUiRuntime(): UiRuntime {
  const runtime = useContext(UiRuntimeContext)
  if (!runtime) throw new Error('插件 UI 必须在宿主提供的仓库界面中使用')
  return runtime
}
