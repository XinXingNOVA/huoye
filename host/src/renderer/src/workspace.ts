import { PANEL_LIMITS } from '../../shared/workbench-layout'
import type { CollectionParams } from '../../shared/collection'
import { readEditors, type EditorLayout } from './editor-layout'
import { readSidebars, type SidebarLayout } from './sidebar-layout'
// 工作区：一个窗口里打开的标签页。存在应用本地，按素材库 ID 对应（设计文档 10.3）。

export interface TabEntry {
  id: string
  type: string
  params: Record<string, unknown>
  /** 标签页按自己的存档契约报告的本地状态。 */
  state?: unknown
  /** 宿主应用呈现配置的序号，不是业务版本。 */
  presentationRevision?: number
}

/** 宿主持有的中央工具位置引用；不注册为插件页面，不提供 PageContext。 */
export const TOOL_TAB = 'workspace.tool'
export const toolIdOf = (t: TabEntry | undefined): string | undefined => t?.type === TOOL_TAB && typeof t.params?.toolId === 'string' && t.params.toolId.length > 0 && t.params.toolId.length < 200 ? t.params.toolId : undefined
export const toolTab = (id: string, title: string): TabEntry => ({ id: `tool:${id}`, type: TOOL_TAB, params: { toolId: id, title } })

export interface Workspace {
  version: 1
  /** 本机未保存草稿，由会话管理器单独验证。 */
  drafts?: unknown
  /** 已落盘的方案接续回执，防止重开仓库重复改写工作台。 */
  presetApplication?: string
  /** 侧栏容器及固定工具身份；中央工具位置由 tabs 中 workspace.tool 引用保存。 */
  sidebars?: SidebarLayout
  /** v1 侧栏只读恢复副本；与转换后的工作区同次原子落盘。 */
  sidebarBackup?: unknown
  sidebarBackupV2?: unknown
  sidebarBackupV3?: unknown
  tabs: TabEntry[]
  /** 中央可递归分割的内容区域；active 始终是当前操作组的页面。 */
  editors?: EditorLayout
  active: string
  /** 窗口两侧栏的显隐，与标签页一起按仓库保存在应用本地。 */
  panels: { sidebar: boolean; inspector: boolean }
  /** 面板选择按仓库保存在本机；未知 ID 保留，停用时只在画面上回退。 */
  docks?: Partial<Record<'left' | 'right', string>>
  /** 用户拖动的期望宽度；窗口缩窄时临时让出主区域，不改写此偏好。 */
  panelSizes?: Partial<Record<'sidebar' | 'inspector', number>>
}

export { PANEL_LIMITS } from '../../shared/workbench-layout'
export function panelWidths(sizes: Workspace['panelSizes'], windowWidth: number) {
  const read = (side: keyof typeof PANEL_LIMITS) => {
    const n = sizes?.[side], limit = PANEL_LIMITS[side]
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(limit.min, Math.min(limit.max, n)) : limit.initial
  }
  const sidebar = read('sidebar'), inspector = read('inspector')
  const extra = sidebar + inspector - 416
  const ratio = extra > 0 ? Math.max(0, Math.min(1, (windowWidth - 48 - 320 - 416) / extra)) : 1
  return { sidebar: Math.round(176 + (sidebar - 176) * ratio), inspector: Math.round(240 + (inspector - 240) * ratio) }
}

let counter = 0
export const newTabId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`

export type { CollectionParams } from '../../shared/collection'

export function collectionTab(params: CollectionParams): TabEntry {
  return { id: newTabId(), type: 'collection', params }
}

export const startTab = (): TabEntry => ({ id: newTabId(), type: 'workspace.start', params: {} })

export const ALL_VIEW: CollectionParams = { title: '全部', query: { scope: 'content' }, presetId: 'all' }

export function defaultWorkspace(): Workspace {
  const tab = collectionTab(ALL_VIEW)
  return { version: 1, tabs: [tab], active: tab.id, panels: { sidebar: true, inspector: true }, docks: { left: 'host.navigation', right: 'host.inspector' } }
}

/** 旧版未固定的一侧仅接续一次当前画面，之后不再随中央标签页变化。 */
export function withStableDocks(workspace: Workspace, legacyPanels?: Workspace['docks']): Workspace {
  return { ...workspace, docks: {
    left: workspace.docks?.left ?? legacyPanels?.left ?? 'host.navigation',
    right: workspace.docks?.right ?? legacyPanels?.right ?? 'host.inspector'
  } }
}

/** 提取旧版工作区中持久化的 settings 标签页作为一次性设置浮层打开目标。 */
export function extractLegacySettingsTarget(data: unknown): { scope?: 'application' | 'library'; section?: string } | undefined {
  if (!data || typeof data !== 'object') return undefined
  const w = data as Partial<Workspace>
  if (w.version !== 1 || !Array.isArray(w.tabs)) return undefined
  const activeTab = w.tabs.find(t => t?.id === w.active)
  const settingsTab = (activeTab?.type === 'settings' ? activeTab : undefined) ?? w.tabs.find(t => t?.type === 'settings')
  if (!settingsTab || typeof settingsTab.params !== 'object' || !settingsTab.params) return undefined
  const scope = settingsTab.params.scope === 'application' ? 'application' : 'library'
  const section = typeof settingsTab.params.section === 'string' ? settingsTab.params.section : undefined
  return { scope, ...(section ? { section } : {}) }
}

/** 读回来的工作区要校验：文件可能来自旧版本，或者被手动改坏。 */
export function validWorkspace(data: unknown, knownTypes: (type: string) => boolean): Workspace | undefined {
  if (!data || typeof data !== 'object') return undefined
  const w = data as Partial<Workspace>
  if (w.version !== 1 || !Array.isArray(w.tabs)) return undefined
  const hadSettingsTab = w.tabs.some(t => t?.type === 'settings')
  // 只接续旧本机标签位置；工作副本登记由主进程保留，不再维护旧任务界面。
  const restored = w.tabs.map(t => t?.type === 'file-editing' ? { ...t, type: 'file-editing.page', params: { title: '编辑中', query: { scope: 'content' }, layout: 'masonry' }, state: undefined } : t?.type === 'editing' ? { ...t, type: 'file-editing.page' } : t)
  const filtered = restored.filter(
    (t): t is TabEntry => !!t && typeof t.id === 'string' && typeof t.type === 'string' && t.type !== 'settings' && (t.type === TOOL_TAB ? toolIdOf(t) !== undefined && t.id === toolTab(toolIdOf(t)!, '').id : knownTypes(t.type)) && !!t.params
  )
  const tabs = filtered.length ? filtered.map(t => ({ ...t, presentationRevision: Number.isSafeInteger(t.presentationRevision) && t.presentationRevision! >= 0 ? t.presentationRevision : undefined })) : hadSettingsTab && knownTypes('collection') ? [collectionTab(ALL_VIEW)] : []
  // 旧版仓库数据标签页迁到只读管理视图，保留用户打开的标签。
  for (const t of tabs) if (t.type === 'collection' && t.params.presetId === 'records' && knownTypes('management')) {
    t.type = 'management'
    t.params = { presetId: 'records' }
    t.state = undefined
  }
  if (!tabs.length) return undefined
  return {
    version: 1,
    drafts: w.drafts,
    ...(typeof w.presetApplication === 'string' && w.presetApplication.length <= 100 ? { presetApplication: w.presetApplication } : {}),
    sidebars: readSidebars(w.sidebars),
    sidebarBackupV3: w.sidebarBackupV3 ?? ((w.sidebars as { version?: number } | undefined)?.version === 3 ? w.sidebars : undefined),
    sidebarBackupV2: w.sidebarBackupV2 ?? ((w.sidebars as { version?: number } | undefined)?.version === 2 ? w.sidebars : undefined),
    sidebarBackup: w.sidebarBackup ?? ((w.sidebars as { version?: number } | undefined)?.version === 1 ? w.sidebars : undefined),
    editors: readEditors(w.editors, tabs, tabs.some(t => t.id === w.active) ? w.active! : tabs[0].id),
    tabs,
    active: tabs.some((t) => t.id === w.active) ? w.active! : tabs[0].id,
    ...(w.docks && typeof w.docks === 'object' ? { docks: Object.fromEntries(Object.entries(w.docks).filter(([k, v]) => ['left', 'right'].includes(k) && typeof v === 'string' && v.length < 150)) } : {}),
    ...(w.panelSizes && typeof w.panelSizes === 'object' ? { panelSizes: Object.fromEntries(Object.entries(w.panelSizes).filter(([k, v]) => ['sidebar', 'inspector'].includes(k) && typeof v === 'number' && Number.isFinite(v))) } : {}),
    // 旧工作区没有此项；只有明确的 false 才收起，坏值也回到默认展开。
    panels: { sidebar: w.panels?.sidebar !== false, inspector: w.panels?.inspector !== false }
  }
}
