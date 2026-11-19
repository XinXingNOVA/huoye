import type { ComponentType } from 'react'
import type { UiHost } from './contracts'
import type { WorkbenchLayout } from '../../shared/workbench-layout'
export type { WorkbenchLayout, WorkbenchNode, WorkbenchSurface, WorkbenchContents } from '../../shared/workbench-layout'
export type { SidebarLayout } from '../../shared/sidebar-layout'

/** 声明 workbench-presets-v1；描述位置；内容编排另声明 workbench-content-v1，不携带草稿或业务数据。 */
export interface WorkbenchPresetContribution {
  id: string
  title: string
  description?: string
  layout: WorkbenchLayout
}
/** 运行时生成的可读预览，不持久化、不挂载内容组件。 */
export interface WorkbenchSurfaceDescription { title: string; detail?: string }
export interface WorkbenchPresetPreview {
  contents: Record<string, WorkbenchSurfaceDescription[]>
  tools: { id: string; title: string }[]
  issues: string[]
}
export type PresetSource = { kind: 'builtin' } | { kind: 'plugin'; id: string; title: string } | { kind: 'user' } | { kind: 'scheme'; id: string; title: string }
export interface PresetInfo extends WorkbenchPresetContribution {
  source: PresetSource
  editable: boolean
  missingViews: string[]
  /** 内容、呈现与放置检查；未接入的页面不会被自动打开。 */
  issues?: string[]
}
export type ReadonlyPresetValue<T> = T extends object ? { readonly [K in keyof T]: ReadonlyPresetValue<T[K]> } : T
export type PresetSnapshot = ReadonlyPresetValue<{
  presets: PresetInfo[]
  current?: WorkbenchLayout
  views: { id: string; title: string }[]
  canReturn: boolean
  /** 用户目录损坏时仍能使用插件／内置预设；写操作拒绝覆盖坏目录。 */
  catalogError?: string
  /** 当前工作区无法捕获为预设时，保留工作区并报告原因。 */
  currentError?: string
}>
/** 当前窗口、当前仓库的本机服务；同步动作失败会抛错。快照冻结且引用稳定，可用于 useSyncExternalStore。 */
export interface WorkbenchPresetService {
  getSnapshot(): PresetSnapshot
  subscribe(listener: () => void): () => void
  /** 只读解析；缺失或异常贡献逐项报告，几何示意仍由 layout 绘制。 */
  preview(layout: ReadonlyPresetValue<WorkbenchLayout>): ReadonlyPresetValue<WorkbenchPresetPreview>
  saveCurrent(title: string): string
  copy(id: string, title: string): string
  updateFromCurrent(id: string): void
  rename(id: string, title: string): void
  remove(id: string): void
  apply(id: string): void
  back(): void
}
export interface WorkbenchPresetUiProps { host: UiHost; intent: 'manage' | 'save'; close(): void }
/** 数值较小者优先；默认宿主界面为 1000，同级按贡献 ID 排序。 */
export interface WorkbenchPresetUi {
  id: string
  priority: number
  Component: ComponentType<WorkbenchPresetUiProps>
}

/** 声明 workbench-content-v1。均为同步纯转换，不接收 host，不写库、不创建业务记录。
 * capture 返回 undefined 表示当前内容不适合进入预设（如具体文件、保存视图）。
 * resolve 必须校验 target，拒绝失效入口；升级时由页面提供方接续自己的描述。
 */
export interface PageWorkbenchAdapter<P = Record<string, unknown>, S = unknown> {
  capture(params: P, saved: S | undefined): { target: Record<string, unknown>; presentation?: Record<string, unknown> } | undefined
  resolve(target: Record<string, unknown>): P
  /** 预览用纯文本描述，不调用 Title / Component，不读取或创建业务数据。 */
  describe?(target: Record<string, unknown>, presentation: Record<string, unknown> | undefined): WorkbenchSurfaceDescription
  /** 仅更新已声明的呈现字段；必须保留搜索、选择、草稿等其他状态。
   * 已挂载组件根据 TabProps.presentationRevision 采用新的 saved 呈现，不重建整个页面。 */
  presentation?: {
    capture(params: P, saved: S | undefined): Record<string, unknown>
    apply(params: P, saved: S | undefined, value: Record<string, unknown>): S
  }
}
