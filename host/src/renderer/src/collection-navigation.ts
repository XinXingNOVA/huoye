import type { CollectionParams, Workspace } from './workspace'
import { editorsOf, groupOf } from './editor-layout'

/** 导航入口的意图快照；与底层 openTab 的显式开页／多实例规则分开。 */
export interface CollectionNavigationTarget {
  newTab?: boolean
  origin?: string
  group?: string
}
type Decision = { action: 'activate'; id: string } | { action: 'replace'; id: string } | { action: 'open'; group: string }
const identity = (params: Record<string, unknown>) =>
  typeof params.viewId === 'string' && params.viewId ? `saved:${params.viewId}`
    : typeof params.presetId === 'string' && params.presetId ? `preset:${params.presetId}` : undefined

/** 只在目标组复用，不按查询内容合并页面，也不重置被定位页的局部状态。 */
export function chooseCollectionNavigation(w: Workspace, params: CollectionParams, target: CollectionNavigationTarget = {}, recent: readonly string[] = []): Decision {
  const group = editorsOf(w).groups.find(g => g.id === target.group) ?? groupOf(w, target.origin) ?? groupOf(w)!
  if (target.newTab) return { action: 'open', group: group.id }
  const key = identity(params)
  if (key) {
    const matches = new Set(w.tabs.filter(t => group.tabs.includes(t.id) && t.type === 'collection' && identity(t.params) === key).map(t => t.id))
    const existing = [group.active, ...recent, ...group.tabs].find(id => matches.has(id))
    if (existing) return { action: 'activate', id: existing }
  }
  // 异步命令／设置退出期间若用户换页，不替换后来激活的页面。
  const source = w.tabs.find(t => t.id === (target.origin ?? group.active))
  if (source?.id === group.active && source.type === 'collection') return { action: 'replace', id: source.id }
  return { action: 'open', group: group.id }
}
