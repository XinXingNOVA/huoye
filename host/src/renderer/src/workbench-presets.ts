import { retainBoundTools } from './sidebar-layout'
import { editorsOf, groupOf, nodeGroups, type EditorGroup, type EditorNode } from './editor-layout'
import { readWorkbenchLayout, object, validId, type WorkbenchLayout } from '../../shared/workbench-layout'
export { readWorkbenchLayout } from '../../shared/workbench-layout'
export type { WorkbenchLayout } from '../../shared/workbench-layout'
import { PANEL_LIMITS, startTab, type Workspace, type TabEntry } from './workspace'

export interface LayoutPreset { id: string; title: string; layout: WorkbenchLayout }
export interface LayoutReturnPoint { layout: WorkbenchLayout; groups: EditorGroup[] }
const group = (id: string): EditorNode => ({ type: 'group', id })
export const BUILTIN_LAYOUTS: readonly LayoutPreset[] = [
  { id: 'host.organize', title: '整理', layout: { version: 1, root: group('layout-main'), primary: 'layout-main', panels: { sidebar: true, inspector: true } } },
  { id: 'host.focus', title: '专注', layout: { version: 1, root: group('layout-main'), primary: 'layout-main', panels: { sidebar: false, inspector: false } } },
  { id: 'host.compare', title: '对照', layout: { version: 1, root: { type: 'split', id: 'layout-split', direction: 'columns', ratio: 0.5, first: group('layout-main'), second: group('layout-reference') }, primary: 'layout-main', panels: { sidebar: false, inspector: false } } }
]
export function captureWorkbenchLayout(w: Workspace): WorkbenchLayout {
  return readWorkbenchLayout({ version: 1, root: editorsOf(w).root, primary: groupOf(w)!.id, panels: w.panels,
    panelSizes: { sidebar: w.panelSizes?.sidebar ?? PANEL_LIMITS.sidebar.initial, inspector: w.panelSizes?.inspector ?? PANEL_LIMITS.inspector.initial }, sidebars: w.sidebars })
}
export function captureLayoutReturnPoint(w: Workspace): LayoutReturnPoint {
  return { layout: captureWorkbenchLayout(w), groups: structuredClone(editorsOf(w).groups) }
}
const placeholder = (t: TabEntry) => t.type === 'workspace.start' && t.params.layoutPlaceholder === true

/** All actual TabEntry objects survive. Only empty, host-created placeholders may be discarded. */
export function applyWorkbenchLayout(w: Workspace, raw: WorkbenchLayout, previousGroups?: EditorGroup[]): Workspace {
  const layout = readWorkbenchLayout(raw), slots = nodeGroups(layout.root), before = editorsOf(w)
  const tabById = new Map(w.tabs.map(t => [t.id, t])), real = new Set(w.tabs.filter(t => !placeholder(t)).map(t => t.id))
  const assigned = new Set<string>(), usedGroups = new Set<string>()
  const groups = slots.map(id => ({ id, tabs: [] as string[], active: '' }))
  const primary = groups.find(g => g.id === layout.primary)!
  const fill = (target: EditorGroup, source?: EditorGroup) => {
    if (!source) return
    usedGroups.add(source.id)
    for (const id of source.tabs) if (real.has(id) && !assigned.has(id)) { target.tabs.push(id); assigned.add(id) }
    target.active = target.tabs.includes(source.active) ? source.active : target.tabs[0]
  }
  if (previousGroups) {
    // Return restores the positions of surviving pages, never resurrecting closed pages.
    for (const target of groups) fill(target, previousGroups.find(g => g.id === target.id))
  } else {
    fill(primary, groupOf(w))
    // Match surviving group identities before distributing unmatched groups in visual order.
    for (const target of groups.filter(g => g !== primary)) {
      const matched = before.groups.find(g => g.id === target.id && !usedGroups.has(g.id))
      if (matched) fill(target, matched)
    }
    const remaining = nodeGroups(before.root).map(id => before.groups.find(g => g.id === id)!).filter(g => !usedGroups.has(g.id))
    for (const target of groups.filter(g => g !== primary && !g.tabs.length)) fill(target, remaining.shift())
  }
  for (const id of nodeGroups(before.root).flatMap(id => before.groups.find(g => g.id === id)!.tabs)) {
    if (real.has(id) && !assigned.has(id)) { primary.tabs.push(id); assigned.add(id) }
  }
  const generated: TabEntry[] = [], retainedPlaceholders = new Set<string>()
  for (const target of groups) {
    if (!target.tabs.length) {
      const old = before.groups.find(g => g.id === target.id)?.tabs.map(id => tabById.get(id)!).find(t => placeholder(t) && !retainedPlaceholders.has(t.id))
      const entry = old ?? { ...startTab(), params: { layoutPlaceholder: true } }
      target.tabs.push(entry.id); retainedPlaceholders.add(entry.id)
      if (!old) generated.push(entry)
    }
    if (target.tabs.includes(w.active)) target.active = w.active
    else if (!target.tabs.includes(target.active)) target.active = target.tabs[0]
  }
  const tabs = [...w.tabs.filter(t => !placeholder(t) || retainedPlaceholders.has(t.id)), ...generated]
  const active = tabs.some(t => t.id === w.active) ? w.active : primary.active
  const activeGroup = groups.find(g => g.tabs.includes(active))!
  return { ...w, tabs, active, editors: { version: 2, root: layout.root, groups, recent: [activeGroup.id, ...slots.filter(id => id !== activeGroup.id)] },
    panels: layout.panels, ...(layout.panelSizes ? { panelSizes: layout.panelSizes } : {}), ...(layout.sidebars ? { sidebars: w.sidebars ? retainBoundTools(layout.sidebars, w.sidebars) : layout.sidebars } : {}) }
}

/** Local, per-library preferences. Writes complete before callers replace their in-memory list. */
export class LayoutPresetStore {
  readonly key: string
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>, libraryId: string) { this.key = `rm:workbench-presets:${libraryId}` }
  list(): LayoutPreset[] {
    const text = this.storage.getItem(this.key)
    if (!text) return []
    if (text.length > 2 * 1024 * 1024) throw new Error('布局预设文件过大')
    const data = object(JSON.parse(text))
    if (data.version !== 1 || !Array.isArray(data.presets) || data.presets.length > 40) throw new Error('布局预设列表格式不正确')
    const ids = new Set<string>(), names = new Set<string>()
    return data.presets.map(raw => {
      const p = object(raw), title = this.title(p.title)
      if (!validId(p.id) || p.id.startsWith('host.') || ids.has(p.id) || names.has(title)) throw new Error('布局预设标识或名称重复')
      ids.add(p.id); names.add(title)
      return { id: p.id, title, layout: readWorkbenchLayout(p.layout) }
    })
  }
  private title(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('名称需要 1～80 个字符')
    return value.trim()
  }
  private write(rows: LayoutPreset[]) {
    const text = JSON.stringify({ version: 1, presets: rows })
    if (text.length > 2 * 1024 * 1024) throw new Error('布局预设总大小超过限制')
    const previous = this.storage.getItem(this.key)
    if (previous && !this.storage.getItem(`${this.key}:before-sidebars-v4`)) {
      const parsed = JSON.parse(previous)
      if (parsed.presets?.some((p: { layout?: { sidebars?: { version?: number } } }) => [1, 2, 3].includes(p.layout?.sidebars?.version ?? 0))) {
        this.storage.setItem(`${this.key}:before-sidebars-v4`, previous)
      }
    }
    this.storage.setItem(this.key, text)
    return rows
  }
  save(title: string, layout: WorkbenchLayout) {
    const rows = this.list(), name = this.title(title)
    if (rows.length >= 40) throw new Error('最多保存 40 个布局预设')
    if (rows.some(p => p.title === name)) throw new Error('已有同名预设，请换个名称或更新已有预设')
    return this.write([...rows, { id: crypto.randomUUID(), title: name, layout: readWorkbenchLayout(layout) }])
  }
  change(id: string, patch: { title?: string; layout?: WorkbenchLayout }) {
    const rows = this.list(), item = rows.find(p => p.id === id)
    if (!item) throw new Error('预设已不存在，请重新打开列表')
    const title = patch.title === undefined ? item.title : this.title(patch.title)
    if (rows.some(p => p.id !== id && p.title === title)) throw new Error('已有同名预设')
    return this.write(rows.map(p => p.id === id ? { ...p, title, ...(patch.layout ? { layout: readWorkbenchLayout(patch.layout) } : {}) } : p))
  }
  remove(id: string) { return this.write(this.list().filter(p => p.id !== id)) }
}
