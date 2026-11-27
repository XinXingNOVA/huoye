import type { TabApi, UiHost } from './contracts'

/** 页面通过 expose 报告的运行时能力。只在本窗口有效，不写入布局或仓库。 */
export interface PageContextSource {
  title?: string
  /** 使用插件命名空间，如 reader.outline；值由提供方和使用方约定。 */
  capabilities?: Readonly<Record<string, unknown>>
}
export interface PageContext {
  readonly pageId: string
  readonly type: string
  readonly title: string
  readonly selection: readonly string[]
  readonly capabilities: Readonly<Record<string, unknown>>
  /** 异步动作完成前检查来源仍存活；不表示它仍是当前操作页。 */
  isAvailable(): boolean
}
/** 宿主从 TabApi 的 facetQuery + toggleFilter 适配的 collection.filter 能力。 */
export type CollectionFilterCapability = Required<Pick<TabApi, 'facetQuery' | 'toggleFilter'>> & Pick<TabApi, 'filters' | 'has' | 'blockFacetQuery' | 'setHasFilters'>
export interface ContextToolRule {
  /** 所有能力都具备才可使用；不能通过页面名称猜测。 */
  requires: string[]
  defaultVisible?: boolean
  /** 声明 bound-context-tools-v1；明确支持独立固定实例。每窗口最多 1～16 份固定实例（不含智能组）。同工具／页面复用。 */
  detachable?: { maxInstances: number }
}
export interface ToolViewProps {
  capabilities?: import('../../shared/image-reads').PageCapabilities
  imageReads?: import('../../shared/image-reads').PageImageReads
  host: UiHost
  /** 此工具实例当前呈现；多个组可同时为 true，不等同于中央页面的唯一操作焦点。 */
  active: boolean
  /** 仅声明 context 的工具获得；按来源页面隔离实例。普通工具继续原语义。 */
  context?: PageContext
}
