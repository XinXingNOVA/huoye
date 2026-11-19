import type { KeyHandler, TabApi, UiHost } from '../../../plugin-api/ui/contracts'
import type { TabEntry } from '../workspace'

/** 窗口内部的只读访问。实现读取当前状态，不向输入／收录模块暴露可写 ref 或 setState。 */
export interface PageAccess {
  entries(): readonly TabEntry[]
  group(id?: string): string | undefined
  otherGroup(group: string): string | undefined
  active(): string | undefined
  entry(id: string): TabEntry | undefined
  api(id: string): TabApi | null | undefined
  focus(id: string): string[]
  keys(id: string): KeyHandler | undefined
  activeGroupTabs(): readonly string[]
  groupActive(id: string | undefined): string | undefined
}

/** 生命周期需要页面宿主，宿主需要工作区动作；仅在顶层连接这两个延迟调用。 */
export interface PageHosts {
  forPage(id: string): UiHost
  forget(id: string): void
}
