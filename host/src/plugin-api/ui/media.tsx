import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from './contracts'
import { useUiRuntime } from './internal/runtime'

/** 标准素材卡片标题区的高度（px）；计算封面尺寸时显式传给布局工具。 */
export const RESOURCE_CARD_CAPTION_HEIGHT = 28
export interface ResourceCardProps {
  id: string
  host: UiHost
  selected: boolean
  /** workbench-session-v1：临时展示提示，不改变选区。 */
  highlighted?: boolean
  style: CSSProperties
  onPointer(id: string, event: MouseEvent): void
  onOpen(id: string): void
  dragIds?(id: string): string[]
}
export interface ResourceCoverProps {
  view: EntityView
  host: UiHost
  /** 没有封面提供者时显示；不增加额外 DOM 外壳。 */
  fallback?: ReactNode
}
export interface EmbedProps { id: string; host: UiHost; fallback?: string }

/** 宿主标准素材卡片；选择与排列由使用它的布局控制。 */
export function ResourceCard(props: ResourceCardProps) {
  const { Card } = useUiRuntime().components
  return <Card {...props} />
}
/** 使用当前启用插件的封面仲裁结果。 */
export function ResourceCover(props: ResourceCoverProps) {
  const { Cover } = useUiRuntime().components
  return <Cover {...props} />
}
export function Embed(props: EmbedProps) {
  const { Embed: Component } = useUiRuntime().components
  return <Component {...props} />
}

/** 与标准卡片一致的角标外观；状态订阅归贡献组件，返回 null 可隐藏整个角标。 */
export function ResourceBadge({ children, color, title }: { children?: ReactNode; color?: string; title?: string }) {
  return children == null ? null : <span className="badge" title={title} style={color ? { background: color } : undefined}>{children}</span>
}
