// 插件接口（界面部分）：呈现相关的扩展点。后端部分见 src/plugin-api/core/contracts.ts。
//
// 单值扩展点（封面、标题、预览器、拖出、图标）：按 priority 从小到大，第一个匹配的生效。
// 打开方式：列出所有匹配项；未指定和未设置偏好时按 priority 选择。
// 多值扩展点（检查器分区、卡片角标、侧栏分面、预设视图、标签页类型、布局）：全部生效，按 order 排序。
//
// 拖入区域：标签页里的某块区域（例如看板的一列）标上 data-drop-zone 和 data-drop-title，
// 宿主把区域键交给所属页面／导航／工具实例的 dropQuery；位置和窗口不改变业务规则。

import type { FC, MouseEvent, ReactNode, DragEvent } from 'react'
import type { PluginNeeds } from '../../shared/plugin-plan'
import type { BlockData, BlockKind, EntityView } from '../../shared/blocks'
import type { Cond, FacetItem, Query } from '../../shared/query'
import type { CoreClient } from '../core'
import type { SelectionChannel, SelectionAction, SelectionLayer, ContentLocation } from './selection-types'
import type { ContentReference } from '../content-selection'
import type { NavigationList } from './navigation'
import type { StreamOptions } from '../local-service'
import type { PageInputs } from '../../shared/page-inputs'
export type { PageInputs } from '../../shared/page-inputs'

export type ContextMenuItem = { type: 'separator' } | { id: string; label: string; accelerator?: string; danger?: boolean }

/** 检查器匹配时的只读查询上下文；不暴露注册容器或写入口。 */
export interface DefinitionContext {
  hasContentLocation(source: EntityView): boolean
  kind(id: string): BlockKind | undefined
  kinds(): readonly BlockKind[]
}

/** 宿主提供给插件界面的能力。 */
/** 声明 open-target-v1。默认复用同身份页；显式指定位置时移动已有页。新建见 instance。 */
export interface OpenOptions {
  group?: 'current' | 'other'
  /** 声明 page-instances-v1；显式新建独立视图。页面类型必须允许，超限拒绝，不搬走旧页。 */
  instance?: 'new'
  /** 声明 open-with-v1；只对 open 生效。稳定打开器 ID，或 host.choose / host.auto / host.data / host.system。 */
  opener?: string
}

/** 窗口呈现与位置属于本机工作区，精简模式支持单页紧凑尺寸。 */
export type PageWindowTarget = 'main' | { kind: 'floating'; minimal?: boolean; pinned?: boolean; width?: number; height?: number }
export type TabOpenOptions = (OpenOptions & { window?: undefined }) | { window: PageWindowTarget; group?: never; instance?: 'new' }

/** 当前仓库窗口内的数量规则；省略 max 不设数量上限。content 必须同时提供 key。 */
export interface PageInstances { scope: 'content' | 'type'; max?: number }

/** 当前仓库窗口的组合能力；各服务分别管理状态，不以 UI 入口决定数据归属。 */
export interface UiHost {
  /** plugin-local-state-v1；命名空间隔离的小型本机界面偏好。 */
  localState(pluginId: string, scope?: import('../local-service').LocalScope): import('./local-state').PluginUiState
  /** 声明 ui-extension-points-v1；当前仓库窗口的静态贡献目录。 */
  extensions: import('./extension-types').UiExtensions
  /** 声明 settings-navigation-v1；目录、导航及离开前检查，呈现可替换。 */
  settings: import('./settings').SettingsService
  openSettings(target?: import('./settings').SettingsTarget): Promise<boolean>
  /** 声明 ui-commands-v1；只负责 UI 命令，不自动发布到 MCP。 */
  commands: import('./commands').CommandService
  /** 同仓库窗口内共享草稿；插件负责条件写入及冲突语义。 */
  editing: import('./editing').EditingSessions
  /** 声明 file-working-copy-service-v1；本机原文件工作副本，独立于字符串草稿。 */
  fileEditing: import('./file-editing').FileEditingService
  /** 声明 plugin-presets-v1；应用级组合目录，应用选择只影响当前仓库。 */
  pluginPresets: import('./plugin-presets').PluginPresetService
  /** 声明 workbench-presets-v1；本机当前仓库的预设服务，预览不变更工作区。 */
  workbenchPresets: import('./workbench-presets').WorkbenchPresetService
  /** 使用当前选中的管理界面；插件未提供时使用内置界面。 */
  openWorkbenchPresets(intent?: 'manage' | 'save'): void
  selection: SelectionChannel
  selectionLayers(): SelectionLayer[]
  revealContent(reference: ContentReference, focus?: string): void
  /** 打开工具视图，遵循用户位置；侧栏展开所属组，中央定位已有页。上下文工具选中当前智能组候选。 */
  showView(id: string): void
  /** 调用本仓库已启用服务的设置／本机能力；外部连接不能访问此入口。 */
  service(plugin: string, method: string, input?: unknown): Promise<unknown>
  /** 一次可取消的持续调用；onData 逐段消费。切换面板不自动取消，拥有者卸载时应 abort。 */
  streamService(plugin: string, method: string, input: unknown, options: StreamOptions): Promise<void>
  core: CoreClient
  /** 同步在拖拽手势中调用；读取缓存、选择原文件拖出或内部身份拖动由宿主完成。 */
  startDrag(event: DragEvent, ids: string[]): void
  /** 返回选择项 ID；取消为 null。菜单等待期间插件应保留打开时的上下文。 */
  contextMenu(items: ContextMenuItem[]): Promise<string | null>
  /** 已启用且依赖满足的协作贡献，由宿主仲裁。 */
  overlays<S extends keyof OverlaySpaces>(space: S): Extract<OverlayDef, { space: S }>[]
  root: string
  /** 库内相对路径 → 页面可用的 URL；version 用于刷新缓存。 */
  url(rel: string, version?: number): string
  /** 库内相对路径 → 绝对路径。 */
  abs(rel: string): string
  kind(id: string): BlockKind | undefined
  /** 全部已注册的数据块定义（例如看板列出能分列的字段）。 */
  kinds(): BlockKind[]
  /** 素材的标题（标题扩展点仲裁后的结果）。 */
  title(v: EntityView): string
  reveal(abs: string): void
  /** 用系统浏览器打开网页链接（只接受 http / https）。 */
  openExternal(url: string): void
  /** 在来源页面切换条件。exclusive-filter-v1：exclusive 原子替换同字段临时条件；不支持筛选时提示。 */
  toggleFilter(cond: Cond, options?: { exclusive?: boolean }): void
  /** 临时预览：浮层显示，不离开当前标签页。 */
  preview(id: string): void
  /** 打开：按素材的打开方式，开专用标签页或通用详情。from：从哪个列表打开（例如播放器据此切上一个 / 下一个）。 */
  open(id: string, from?: NavigationList, options?: OpenOptions): void
  /** 声明 file-working-copy-v1。从本库已接纳版本创建／复用本机工作副本并打开；失败保留修改；界面由已启用贡献提供，未启用时提示且不创建副本。options 需声明 file-working-copy-ui-v1。 */
  editFile(id: string, options?: Omit<import('./file-editing').FileEditingUiRequest, 'id'>): void
  /** 直接查看通用数据详情，独立于专用打开方式；也适用于组织记录及休眠数据。 */
  openData(id: string, options?: OpenOptions): void
  /** 打开中央内容页；是否复用由 key / instances 和 OpenOptions 决定，不保证每次新建。 */
  openTab(type: string, params: Record<string, unknown>, options?: TabOpenOptions): void
  /** 快速附加：给这些身份挂数据块、打标签、填字段（设计文档 11.5）。 */
  quickAttach(ids: string[]): void
  /** 给用户一句短提示（例如"已删除字段，可以撤销"）。 */
  notify(text: string): void
  /** 导出这些身份（打开导出对话框，先预览再确认）。name：默认的文件夹名。 */
  export(ids: string[], name: string): void
  /** 通用记录取回，包含定义、依附关系、原文件；独立于插件的格式导出器。 */
  takeout(ids: string[], name: string): void
  /** 移到回收站（可以撤销），给一句提示。 */
  trash(ids: string[]): void
  /** 彻底删除回收站里的这些身份：打开确认框，先说清楚会删什么，再删（设计文档 11.13）。 */
  purge(ids: string[]): void
  /** 右键菜单：这些身份能做的操作（操作扩展点），点了哪个就做哪个。 */
  showActions(ids: string[]): void
  /** 空白处的新建菜单：列出启用插件的创建项，按打开菜单时的上下文创建。 */
  showCreateMenu(context: CreationContext): void
  /** 改名：交给给出它们标题的那个插件（一批里要是同一个）；不能改名时给一句提示。 */
  rename(ids: string[]): void
  /** 弹出一个对话框（插件自己的界面，例如改名）。render 拿到 close，做完了调它。Esc、点外面也会关。 */
  showDialog(render: (close: () => void) => ReactNode): void
  /** 拖进来的东西里认出库里的身份：窗口里拖的卡片、从库里拖出去又拖回来的文件。库外的文件不算。 */
  idsFromDrop(dt: DataTransfer): string[]
}

export interface ViewProps {
  view: EntityView
  host: UiHost
}

/** 摘要已呈现的字段；分区只省略这些显示，原数据及完整详情不变。 */
export interface InspectorSectionProps extends ViewProps {
  summarizedFields?: readonly { kind: string; field: string }[]
}
/** 一个实际存在的数据块的详情分区；标题、折叠和排序由宿主提供。 */
export interface BlockSectionProps extends InspectorSectionProps {
  kind: BlockKind
}
export interface BlockSection extends PluginNeeds {
  id: string
  /** 同一数据块匹配多个提供方时，数值小的优先。 */
  priority: number
  /** 没有用户布局时的默认位置。 */
  order: number
  match(kind: BlockKind): boolean
  Component: FC<BlockSectionProps>
}

/** 按键处理：返回 true 表示已处理，宿主不再往下传。 */
export type KeyHandler = (e: KeyboardEvent) => boolean

/** 预览内容可以接管按键（例如视频里空格是播放 / 暂停）。 */
export interface PreviewProps extends ViewProps {
  registerKeys(handler: KeyHandler | null): void
}

// ---------- 标签页（设计文档第 10 节） ----------

export type { PageContext, PageContextSource, ContextToolRule, ToolViewProps, CollectionFilterCapability } from './page-context'

/** 标签页向窗口暴露的能力：侧栏分面、拖入。 */
export interface TabApi {
  /** page-delete-v1。处理当前页面选择，空选也由页面消费；删除目标与检查器焦点分别决定。 */
  pageSelection?: { ids: readonly string[]; remove(): void | Promise<void> }
  /** workbench-session-v1：运行中的集合现场与临时定位。 */
  collectionSession?: import('../../shared/workbench-session').CollectionSessionApi
  /** 声明 context-tools-v1；智能工具使用的标题与能力。 */
  context?: import('./page-context').PageContextSource
  /** 当前视图的导航范围；宿主菜单／详情里的打开动作未显式指定来源时使用。 */
  navigation?: NavigationList
  /** 侧栏分面范围：保留基础规则、搜索和动态身份，只排除这个字段的临时 where 条件。
   * undefined 沿用全库；空 ids 表示空范围。集合页面自动提供，定制页面可选择接入。 */
  facetQuery?(kind: string, field: string): Query | undefined
  /** block-facets-v1：仅排除指定块的临时 has，保留基础规则及其他筛选。 */
  blockFacetQuery?(kinds: readonly string[]): Query | undefined
  filters?: Cond[]
  /** 按完整条件切换（含层级关系）；相同则移除，列表字段追加不同条件，单值字段替换。
   * 不修改基础视图规则；普通单选或按键多选的手势由调用方决定。
   * exclusive-filter-v1：exclusive=true 原子替换同字段条件；仅有同一条件时再点移除。 */
  toggleFilter?(cond: Cond, options?: { exclusive?: boolean }): void
  /** 当前页面临时附加的“挂有某数据块”筛选列表（如模板 `tpl:<id>`）。 */
  has?: readonly string[]
  /** block-facets-v1：一次替换 kinds 范围内的临时 has；selected 必须属于 kinds。多个块为 AND。 */
  setHasFilters?(kinds: readonly string[], selected: readonly string[]): void
  selectAll?(): void
  /** 选中这些身份（例如刚收录进来的）。 */
  select?(ids: string[]): void
  /** ⌘F：到这个标签页的搜索框。 */
  find?(): void
  /** ⇧⌘E 导出什么：选中的，没选就是整个视图。 */
  exportable?(): { ids: string[]; name: string }
}

export interface TabProps<P = Record<string, unknown>, S = unknown> {
  capabilities?: import('../../shared/image-reads').PageCapabilities
  imageReads?: import('../../shared/image-reads').PageImageReads
  id: string
  params: P
  host: UiHost
  /** 是否为当前操作页面，全窗口仅一个；快捷键和选区仍按它路由。 */
  active: boolean
  /** 当前组正在显示此页。分屏时可以可见但不 active；绘制可用此标志。 */
  visible: boolean
  /** 上次保存的本地状态：重启后或冻结后恢复用。 */
  saved: S | undefined
  /** workbench-content-v1：仅此值变化时，从 saved 接续新的呈现字段；不能重置编辑等其他状态。 */
  presentationRevision?: number
  /** 报告本地状态，宿主在退出、冻结时按它恢复（存档契约）。 */
  setState(state: S): void
  /** 有 beforeLeave 时在结束回调成功后更新；以收到的新 params 判断完成。 */
  setParams(params: P): void
  /** 报告焦点：检查器显示它。 */
  setFocus(ids: string[]): void
  registerKeys(handler: KeyHandler | null): void
  expose(api: TabApi | null): void
  /** 宿主转交本页面类型的输入声明；组件可据此隐藏无效入口。 */
  inputs?: PageInputs
}

export interface TabType<P = Record<string, unknown>, S = unknown> {
  /** 显式加入工作台编排；未声明的页面继续保留现场，但不会被预设自动捕获／创建。 */
  workbench?: import('./workbench-presets').PageWorkbenchAdapter<P, S>
  id: string
  /** @deprecated 仅用于旧工作区首次接续；新的标签切换不再更改侧栏选择。显式入口使用 host.showView。 */
  panels?: { left?: string; right?: string }
  /** 标签栏上的标题（可以用 hooks，例如跟随视图改名）。 */
  Title: FC<{ params: P; host: UiHost }>
  /** 内容身份键。普通打开优先复用同内容页；未声明 instances 时保持每份内容一页。 */
  key?(params: P): string
  /** 声明 page-instances-v1；允许显式新建视图，并约束每份内容或整个类型的数量。 */
  instances?: PageInstances
  /** page-delete-v1。删除键和原生删除菜单交给此页，未挂载时也不转交给素材。 */
  deleteTarget?: 'page'
  /** 声明 page-lifecycle-v1。静态回调：即使组件已暂时卸载仍会执行。失败抛错，宿主保留页面。
   * navigate 用于内容身份变更；无 key 时用 nextParams 判断是否真的离开内容。同身份复用、移动、隐藏和缓存卸载不调用。
   * 只使用已报告的 saved；可重试，应避免重复副作用。组件清理不能代替此回调。 */
  beforeLeave?(context: TabLeaveContext<P, S>): void | Promise<void>
  Component: FC<TabProps<P, S>>
  /** 声明 page-inputs-v1。receive 控制窗口拖入／粘贴／导入，create 控制新建菜单和快捷键；未声明保持既有行为。 */
  inputs?: PageInputs
  /**
   * 拖入这个标签页时的视图查询：能写的条件写上，其余当作准入检查。不提供查询保持普通收录；拒绝输入请声明 inputs。
   * zone：拖到标签页里某个拖入区域时，该区域的 data-drop-zone。
   */
  dropQuery?(params: P, saved: S | undefined, zone?: string): Query | undefined
}

export interface TabLeaveContext<P = Record<string, unknown>, S = unknown> {
  id: string
  params: P
  saved: S | undefined
  host: UiHost
  reason: 'close' | 'replace' | 'navigate' | 'reload' | 'shutdown'
  nextParams?: P
  /** 声明 page-instances-v1；其他同类型、同内容页面的本机快照，包含未挂载页。无身份键时为空。
   * 只读副本，不是共享编辑会话；结束回调不能修改别的页面。 */
  otherViews: readonly { id: string; params: P; saved: S | undefined }[]
  /** 超时或应用取消退出时触发；结束异步工作前应检查，不能继续关闭页面。 */
  signal: AbortSignal
}

/** 预设视图：插件提供，不写进库；修改后另存才成为库里的视图。 */
export interface PresetView {
  layout?: string
  options?: Record<string, unknown>
  /** 默认打开集合；可指定已注册的只读或专用标签页。 */
  tab?: string
  /** 仅控制左侧导航初始显隐，不停用能力。 */
  defaultVisible?: boolean
  id: string
  title: string
  query: Query
  order: number
}

/** 浏览布局的声明；使用新增配置／状态能力时声明 browsing-layout-v1。 */
export interface LayoutDef {
  id: string
  title: string
  description?: string
  defaultOptions?: Record<string, unknown>
  /** workbench-session-v1：支持 DOM 提交回执、定位和独立于选区的高亮。 */
  session?: true
  /** false 隐藏；省略保留旧包的卡片尺寸控制。值仍通过 LayoutProps.zoom 传入。 */
  size?: false | { label: string; min: number; max: number; step?: number; default: number }
  Component: FC<LayoutProps>
  Options?: FC<LayoutOptionsProps>
}

/** 集合标签页的布局。 */
export interface LayoutProps {
  /** 声明 session 的布局须消费高亮/定位，并在提交后报告实际挂载的身份。 */
  session?: import('../../shared/workbench-session').LayoutSession
  /** 标签页的有效查询（视图 + 临时筛选）。布局可以在它上面再加条件，例如看板的每一列。 */
  query: Query
  ids: string[]
  aspects: number[]
  /** 布局选项，存在视图里（例如看板按哪个字段分列）。 */
  options: Record<string, unknown>
  zoom: number
  selection: Set<string>
  host: UiHost
  active: boolean
  /** 本布局在标签组中是否可见，和唯一键盘操作焦点 active 分开。 */
  visible: boolean
  /** 本布局上次报告的本页状态；只保存 JSON 对象，切换布局与重启后接续。 */
  state?: Record<string, unknown>
  onState(state: Record<string, unknown>): void
  /** 恢复时滚到这个身份。 */
  anchor?: string
  onAnchor(id: string): void
  /** order：按住 Shift 连选时的顺序（例如看板里只在一列内连选），默认是 ids。 */
  onPointer(id: string, e: React.MouseEvent, order?: string[]): void
  /** 从这张卡片开始拖动时，一起拖走的身份（按在已选中的卡片上时是整个选择）。 */
  dragIds(id: string): string[]
  /** 可传列内／视觉顺序；宿主会与当前结果相交后交给阅读器导航。 */
  onOpen(id: string, order?: readonly string[]): void
  onBackground(): void
  /** 空白处右键。布局可以提供更具体的查询，例如看板所在列的条件。 */
  onBackgroundMenu(e: MouseEvent, query?: Query): void
}

/** 创建位置的快照：菜单等待选择时，不能跟着当前标签页或筛选变化。 */
export interface CreationContext {
  tabId: string
  query?: Query
}

/** 插件声明能创建什么、如何打开；身份创建和视图准入由宿主执行。 */
export interface CreatorDef {
  id: string
  title: string
  order: number
  blocks(): Record<string, BlockData>
  open?(id: string): { tab: string; params: Record<string, unknown> }
}

/**
 * 操作（设计文档 11.13）：对选中的身份能做什么，出现在右键菜单和检查器里（同一份，两种呈现）。多值，全部生效；
 * 按 group 分段（段之间有分隔线），段内按 order。约定的段：10 打开，20 整理，30 文件与导出，90 删除。
 */
export interface ActionDef {
  /** 所选项包含容器时仍可使用。 */
  includeContainers?: boolean
  id: string
  group: number
  order: number
  /** 菜单上的字，可以按选中的是什么来写。 */
  title: string | ((views: EntityView[]) => string)
  /** 快捷键，只显示在菜单上（按键由各处自己处理）。Electron 的写法，例如 'CmdOrCtrl+Backspace'。 */
  accelerator?: string
  /** 检查器优先呈现；其余及危险操作保留在更多菜单。排序沿用 group/order。 */
  inspector?: 'primary' | 'shortcut'
  icon?: import('./commands').QuickActionIcon
  /** 对这些身份适用吗；不适用的不出现。不提供时总是适用。 */
  when?(views: EntityView[]): boolean
  /** 会删掉东西的（移到回收站、彻底删除）：显示成红色。 */
  danger?: boolean
  run(views: EntityView[], host: UiHost): void
}

export type FacetDef = {
  /** 同一字段的多个呈现使用各自稳定 ID（插件命名空间）。 */
  id?: string
  title: string
  order: number
} & (
  { source?: 'field'; kind: string; field: string; Component?: FC<FacetProps> } |
  /** block-facets-v1：组件以 kindCounts + blockFacetQuery 统计块；不触发字段取值查询。 */
  { source: 'blocks'; id: string; kind?: never; field?: never; Component: FC<FacetProps> }
)

export interface FacetProps {
  host: UiHost
  facet: FacetDef
  /** 容器当前可见；隐藏时暂停统计与绘制。 */
  active?: boolean
  items: FacetItem[]
  /** 初次／切换范围时 items 为空；同范围刷新可保留旧值。错误不是空结果。 */
  loading?: boolean
  error?: string
  reload?(): void
  api: TabApi
}

export interface ToolViewContribution extends PluginNeeds {
  id: string
  title: string
  order: number
  Icon?: FC
  /** 新声明需 tool-placement-v1；省略时允许左右两侧，普通工具默认右侧独立成组；只允许左侧时默认左侧。用户已有位置优先。 */
  placement?: {
    regions: ('left' | 'center' | 'right')[]
    /** 普通工具的初始摆放建议；group 可为本插件命名空间内的组合 ID，或 host.navigation / host.inspector。智能候选不填写。 */
    default?: { region: 'left' | 'right'; group?: string }
  }
  /** 声明 context-tools-v1；进入智能容器候选，不自动在普通组创建实例。 */
  context?: import('./page-context').ContextToolRule
  /** content-drop-v1：区块接收规则；上下文工具按实际实例传入来源，不读取全局活动页。
   * 返回 undefined 拒绝；{} 表示默认集合范围。固定、智能、中央及小窗共用。 */
  dropQuery?(zone: string, context?: import('./page-context').PageContext): Query | undefined
  /** 首次显示才挂载，随后隐藏或移动保持实例；active=false 时暂停绘制，不终止服务。 */
  Component: FC<import('./page-context').ToolViewProps>
}

/** 静态 get 兼容既有包；可订阅组件声明 reactive-badges-v1，使用稳定的插件命名空间 ID。 */
export type CardBadge = { order: number } & (
  { id?: string; get(v: EntityView): { text: string; color?: string } | undefined; Component?: never } |
  { id: string; Component: FC<ViewProps>; get?: never }
)

export interface UiPlugin {
  /** 声明 ui-extension-points-v1；扩展点与贡献按所有 UI 加载完成后的目录解析。 */
  extensionPoints?: import('./extension-types').UiExtensionPoint[]
  extensions?: import('./extension-types').UiExtensionContribution[]
  id: string
  /** 声明 workbench-presets-v1；原版只读，按插件启停装配。 */
  workbenchPresets?: (PluginNeeds & import('./workbench-presets').WorkbenchPresetContribution)[]
  workbenchPresetUis?: (PluginNeeds & import('./workbench-presets').WorkbenchPresetUi)[]
  toolViews?: ToolViewContribution[]
  /** 声明 file-working-copy-ui-v1；数值小的优先，当前窗口统一选择一个编辑界面。 */
  fileEditingUis?: { id: string; priority: number; open(request: import('./file-editing').FileEditingUiRequest, host: UiHost): void | Promise<void> }[]
  /** 每个仓库窗口挂载一次，包裹所有标签页、侧栏和部件；重载时卸载。 */
  windowProviders?: (PluginNeeds & { id: string; order: number; Component: FC<{ host: UiHost; children: ReactNode }> })[]
  settingsSections?: import('./settings').SettingsSectionContribution[]
  commands?: import('./commands').CommandContribution[]
  covers?: { priority: number; match(v: EntityView): boolean; Component: FC<ViewProps> }[]
  /**
   * 标题（单值）。rename：标题由谁给，就由谁负责改——打开改名的界面（一个或一批，设计文档 11.14），
   * 例如文件插件改文件名。TitleEditor 可补充详情标题的原地编辑，沿用同一业务入口；完成或取消调用 onDone。
   * 未提供 TitleEditor 时仍调用 rename；两者都无则只读。
   */
  titles?: { priority: number; get(v: EntityView): string | undefined; rename?(views: EntityView[], host: UiHost): void; TitleEditor?: FC<ViewProps & { onDone(): void }> }[]
  previews?: { priority: number; match(v: EntityView): boolean; Component: FC<PreviewProps> }[]
  /** 嵌入：这个素材被嵌进一篇文字里时的样子（![[…]]，设计文档 11.9）。单值，按优先级仲裁；没有时用封面。 */
  embeds?: { priority: number; match(v: EntityView): boolean; Component: FC<ViewProps> }[]
  /** 打开方式：id/title 成对提供；id 以本插件 ID + '.' 开头且跨版本稳定。旧无名打开器可临时选择，不能保存默认。 */
  opens?: ({ id?: string; title?: string; priority: number; match(v: EntityView): boolean } & ({ tab: string; params(v: EntityView, from?: NavigationList): Record<string, unknown> } | { open(v: EntityView, host: UiHost): void }))[]
  /** 拖到其他软件时交出去的文件（绝对路径）。 */
  dragOut?: { priority: number; get(v: EntityView, host: UiHost): string | undefined }[]
  /** 系统层面使用的小图（例如拖动时的图标），绝对路径。 */
  icons?: { priority: number; get(v: EntityView, host: UiHost): string | undefined }[]
  /** 检查器分区。kinds：这个分区负责呈现的数据块，它们不再走通用呈现。 */
  sections?: {
    /** 由检查器在 match 之前按身份过滤。 */
    includeContainers?: boolean
    id: string
    title: string
    order: number
    kinds: string[]
    /** 按定义认领数据块（例如用户模板定义的那些，种类是运行时才有的）。 */
    claims?(kind: BlockKind): boolean
    /** 不提供时：挂有 kinds 中任一数据块才显示。 */
    match?(v: EntityView, definitions: DefinitionContext): boolean
    /** 复用已注册的素材操作，在分区头部提供入口。 */
    actions?: string[]
    Component: FC<InspectorSectionProps>
  }[]
  /** 为未被 sections 认领的块提供专用详情；休眠块保持通用只读呈现。 */
  blockSections?: BlockSection[]
  /** 卡片角标（多值）：显示在封面左上角，按 order 排列。 */
  badges?: CardBadge[]
  /** 侧栏分面：按一个文本字段的取值筛选。 */
  facets?: FacetDef[]
  /** 按数据块定义生成的分面（例如用户模板里的单选字段，种类是运行时才有的）。 */
  facetsFor?(kinds: BlockKind[]): FacetDef[]
  /** 侧栏分组：插件往侧栏加一组导航（例如文件夹目录树）。 */
  /** content-drop-v1：导航区域接收；navigation-context-v1：NavProps.activeTab 高亮上下文。 */
  navs?: { id: string; order: number; dropQuery?(zone: string): Query | undefined; Component: FC<NavProps> }[]
  /**
   * 叠加层（插件扩展插件，设计文档 8.3）：媒体查看器开放自己的坐标系，别的插件在上面画东西。
   * region：图片的比例坐标（0~1），叠加层铺满显示出来的图片。
   * timeline：播放器时间轴上方的一条，左右对应 0 到时长。
   */
  overlays?: OverlayDef[]
  selectionActions?: SelectionAction[]
  selectionLayers?: SelectionLayer[]
  contentLocations?: ContentLocation[]
  views?: PresetView[]
  /** 操作：右键菜单里对选中的身份能做什么（多值）。 */
  actions?: ActionDef[]
  /**
   * 新建：空白处菜单按 order 列出全部创建项；⌘N 使用第一个。
   * 新建的身份先放进当前视图（能写的条件写上），再按 open 打开；没有 open 时按打开方式。
   */
  creates?: CreatorDef[]
  tabTypes?: TabType<any, any>[]
  layouts?: LayoutDef[]
}

/** 打开一个集合标签页的参数（侧栏导航用）。 */
export interface CollectionOpen {
  title: string
  query: Query
  layout?: string
  options?: Record<string, unknown>
  /** 来源的标识，用于高亮与判断是否改过（例如 tpl:<模板>）。 */
  presetId?: string
  /** 来源的布局：改成别的布局时提示另存。 */
  base?: { layout: string; options?: Record<string, unknown> }
}

export interface NavProps {
  host: UiHost
  /** 当前标签页的来源标识（presetId），用来高亮。 */
  current?: string
  /** 当前活动中央标签页的类型与参数（供自定义标签页导航高亮使用）。 */
  activeTab?: { type: string; params: Readonly<Record<string, unknown>> }
  /** newTab：⌘ 点击时在新标签页打开。 */
  open(params: CollectionOpen, newTab: boolean): void
}

/** 每种坐标系的叠加层拿到的东西。 */
export interface OverlaySpaces {
  region: RegionOverlayProps
  timeline: TimelineOverlayProps
  text: TextOverlayProps
  pdf: PdfOverlayProps
}

/** PDF 页面坐标系：阅读器提供渲染完成的文字层与页框，批注插件负责选区和标记。 */
export interface PdfPageSurface {
  page: number
  element: HTMLElement
  textLayer: HTMLElement
}

export interface PdfOverlayProps {
  target: EntityView
  host: UiHost
  active: boolean
  root: HTMLElement
  pages: PdfPageSurface[]
  selected?: string
  select(id: string | undefined): void
  revealId?: string
  revealKey: string
  reveal(page: number, offset: number): void
}

export type OverlayDef = { [S in keyof OverlaySpaces]: PluginNeeds & { id: string; order: number; selection?: 'shared'; space: S; interaction?: S extends 'region' ? 'passive' | 'tool' : never; Toolbar?: S extends 'region' ? FC<RegionOverlayProps> : never; Passive?: S extends 'region' ? FC<RegionOverlayProps> : never; title?: string; Component: FC<OverlaySpaces[S]> } }[keyof OverlaySpaces]

/** 播放器时间轴上的叠加层：和时间轴一样宽，用百分比定位就是 时间 / 时长。 */
export interface TimelineOverlayProps {
  /** 正在播放的素材。 */
  target: EntityView
  host: UiHost
  /** 时长（秒）。 */
  duration: number
  /** 现在播放到哪里（秒）。播放时每帧都在变。 */
  time: number
  playing: boolean
  /** 跳到某一时刻。视频还没读好时，读好后再跳。 */
  seek(t: number): void
  play(): void
  pause(): void
  /** 选中的身份（例如从片段的卡片打开时定位到它）。 */
  selected?: string
  /** 选中一个身份：播放器把焦点交给它，检查器显示它。 */
  select(id: string | undefined): void
  /** 打开播放器时要定位到的身份：叠加层找到它后调一次 reveal。 */
  revealId?: string
  /** 定位到某一时刻：跳过去接着播。重启后恢复的播放器不定位，从上次看到的地方继续。 */
  reveal(t: number): void
  /** 叠加层自己的按键：播放器先问叠加层，再按自己的快捷键处理。 */
  registerKeys(h: KeyHandler | null): void
}

/** 文字的坐标系：排好版的文字里的字符位置（不含链接、嵌入）。 */
export interface TextIndex {
  /** 读得到的全部文字。 */
  text: string
  /** [from, to) 在页面上的范围；超出时 undefined。 */
  range(from: number, to: number): Range | undefined
  /** 页面上的一个位置（节点 + 偏移）是第几个字；不在可数的文字里时 undefined。 */
  offsetOf(node: Node, offset: number): number | undefined
}

/**
 * 文字标签页上的叠加层（阅读时）：铺满整页，用 index 在字符位置和页面上的范围之间换算，
 * 画的东西相对 page 定位。排版或页面大小变了，version 就变，叠加层据此重新量。
 */
export interface TextOverlayProps {
  target: EntityView
  host: UiHost
  /** 排好版的正文（选中的文字要在它里面）。 */
  root: HTMLElement
  /** 叠加层定位的参照（整页，position: relative）。 */
  page: HTMLElement
  index: TextIndex
  version: number
  selected?: string
  select(id: string | undefined): void
  /** 打开时要定位到的身份：叠加层找到它后滚过去，只做一次。 */
  revealId?: string
}

/** 图片查看器上的叠加层：铺满显示出来的图片，用百分比定位就是图片的比例坐标。 */
export interface RegionOverlayProps {
  /** Passive layers remain visible and inert. A tool unmounts on mode change. */
  interactive?: boolean
  /** 正在看的素材。 */
  target: EntityView
  host: UiHost
  /** 选中的身份（例如从局部的卡片打开时定位到它）。 */
  selected?: string
  /** 选中一个身份：查看器把焦点交给它，检查器显示它。 */
  select(id: string | undefined): void
  /** 现在的缩放（显示像素 / 原图像素），叠加层据此决定线条粗细、要不要显示文字。 */
  scale: number
  /** 让查看器放大到一块区域（比例坐标）。 */
  reveal(rect: { x: number; y: number; w: number; h: number }): void
  /** 打开查看器时要定位到的身份：叠加层找到它的区域后调一次 reveal。 */
  revealId?: string
}

export interface LayoutOptionsProps {
  options: Record<string, unknown>
  setOptions(options: Record<string, unknown>): void
  host: UiHost
}
