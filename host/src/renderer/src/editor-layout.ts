import { toolIdOf, startTab, type TabEntry, type Workspace } from './workspace'
import { takeToolFromSidebar } from './sidebar-layout'
import type { ContentWindowState } from '../../shared/auxiliary-windows'

export type EditorDirection = 'columns' | 'rows'
export type EditorEdge = 'left' | 'right' | 'top' | 'bottom'
export interface EditorGroup { id: string; tabs: string[]; active: string; window?: Partial<ContentWindowState> }
export type EditorNode = import('../../shared/workbench-layout').WorkbenchNode
export interface EditorLayout { version: 2; root: EditorNode; groups: EditorGroup[]; recent: string[] }
export const EDITOR_MIN = { width: 260, height: 180 }
export const EDITOR_GAP = 5
const clamp = (n: number) => Math.min(0.999, Math.max(0.001, n))
const leaf = (id: string): EditorNode => ({ type: 'group', id })
export const nodeGroups = (n: EditorNode): string[] => n.type === 'group' ? [n.id] : [...nodeGroups(n.first), ...nodeGroups(n.second)]
const mapNode = (n: EditorNode, fn: (n: EditorNode) => EditorNode): EditorNode => fn(n.type === 'group' ? n : { ...n, first: mapNode(n.first, fn), second: mapNode(n.second, fn) })
function prune(n: EditorNode, ids: Set<string>): EditorNode | undefined {
  if (n.type === 'group') return ids.has(n.id) ? n : undefined
  const first = prune(n.first, ids), second = prune(n.second, ids)
  return first && second ? { ...n, first, second } : first ?? second
}
const freshId = (root: EditorNode, prefix: string): string => {
  const used = new Set<string>(); mapNode(root, n => { used.add(n.id); return n })
  let i = 1; while (used.has(`${prefix}-${i}`)) i++
  return `${prefix}-${i}`
}
function readWindowState(raw: Record<string, unknown>): Partial<ContentWindowState> {
  const state: Partial<ContentWindowState> = {}
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) state[key] = value
  }
  if (raw.pinned === true) state.pinned = true
  if (raw.minimal === true) state.minimal = true
  return state
}
/** 旧两组配置只在读取边界转为树；日常操作只有一种模型。 */
export function readEditors(raw: unknown, tabs: TabEntry[], active: string): EditorLayout {
  const input = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const known = new Set(tabs.map(t => t.id)), assigned = new Set<string>(), groups: EditorGroup[] = []
  if ([1, 2].includes(input.version) && Array.isArray(input.groups)) for (const g of input.groups) {
    if (!g || typeof g.id !== 'string' || !g.id || g.id.length > 100 || groups.some(x => x.id === g.id) || !Array.isArray(g.tabs)) continue
    const ids = g.tabs.filter((id: unknown): id is string => { if (typeof id !== 'string' || !known.has(id) || assigned.has(id)) return false; assigned.add(id); return true })
    if (!ids.length) continue
    const group: EditorGroup = { id: g.id, tabs: ids, active: ids.includes(g.active) ? g.active : ids[0] }
    if (g.window && typeof g.window === 'object') group.window = readWindowState(g.window)
    groups.push(group)
  }
  // 损坏/过滤后的存档只剩浮动组时，把一组放回主窗；不生成没有实际页面的空组。
  if (groups.length && !groups.some(g => !g.window) && tabs.every(t => assigned.has(t.id))) delete groups[0].window
  if (!groups.some(g => !g.window)) groups.unshift({ id: groups.length ? `editor-${crypto.randomUUID()}` : 'editor-1', tabs: [], active })
  groups.find(g => !g.window)!.tabs.push(...tabs.filter(t => !assigned.has(t.id)).map(t => t.id))
  for (const g of groups) { if (g.tabs.includes(active)) g.active = active; if (!g.tabs.includes(g.active)) g.active = g.tabs[0] }
  const used = new Set<string>(), attached = new Set<string>()
  let budget = 1024
  const read = (v: any, depth = 0): EditorNode | undefined => {
    if (!v || typeof v !== 'object' || --budget < 0 || depth > 64) return
    if (v.type === 'group' && groups.some(g => g.id === v.id && !g.window) && !attached.has(v.id)) { attached.add(v.id); return leaf(v.id) }
    if (v.type !== 'split') return
    const first = read(v.first, depth + 1), second = read(v.second, depth + 1)
    if (!first || !second) return first ?? second
    let id = typeof v.id === 'string' && v.id.length < 100 && !groups.some(g => g.id === v.id) ? v.id : `split-${used.size + 1}`
    while (used.has(id) || groups.some(g => g.id === id)) id += '-s'
    used.add(id)
    return { type: 'split', id, direction: v.direction === 'rows' ? 'rows' : 'columns', ratio: Number.isFinite(v.ratio) ? clamp(v.ratio) : 0.5, first, second }
  }
  let root = input.version === 2 ? read(input.root) : undefined
  for (const g of groups) if (!g.window && !attached.has(g.id)) {
    let splitId = root ? freshId(root, 'split') : 'split-1'
    while (groups.some(g => g.id === splitId)) splitId += '-s'
    root = root ? { type: 'split', id: splitId, direction: input.version === 1 && input.direction === 'rows' ? 'rows' : 'columns', ratio: input.version === 1 && Number.isFinite(input.ratio) ? clamp(input.ratio) : 0.5, first: root, second: leaf(g.id) } : leaf(g.id)
    attached.add(g.id)
  }
  const activeGroup = (groups.find(g => g.tabs.includes(active)) ?? groups[0]).id
  const recent = [...new Set([activeGroup, ...(Array.isArray(input.recent) ? input.recent.filter((id: unknown) => typeof id === 'string' && groups.some(g => g.id === id)) : []), ...groups.map(g => g.id)])] as string[]
  return { version: 2, root: root!, groups, recent }
}
export const editorsOf = (w: Workspace): EditorLayout => w.editors ?? readEditors(undefined, w.tabs, w.active)
export const groupOf = (w: Workspace, tab = w.active) => editorsOf(w).groups.find(g => g.tabs.includes(tab))
export const visibleTabs = (w: Workspace) => editorsOf(w).groups.map(g => g.active)
export const otherGroup = (layout: EditorLayout, source: string) => layout.recent.map(id => layout.groups.find(g => g.id === id)).find(g => g && g.id !== source && !g.window?.minimal)

/** group 是明确指定的落点；originGroup 是打开意图发生时的来源。 */
export function openGroup(layout: EditorLayout, target: { group?: string; originGroup?: string; origin?: string; mainOnly?: boolean }) {
  const recent = layout.recent.map(id => layout.groups.find(g => g.id === id)!)
  const main = recent.find(g => !g.window) ?? layout.groups.find(g => !g.window)!
  if (target.mainOnly) return main
  const explicit = layout.groups.find(g => g.id === target.group)
  if (explicit) return explicit
  const source = layout.groups.find(g => g.id === target.originGroup) ?? layout.groups.find(g => target.origin && g.tabs.includes(target.origin))
  return source && !source.window?.minimal ? source : (recent.find(g => !g.window?.minimal) ?? main)
}
function finish(w: Workspace, layout: EditorLayout, active = w.active): Workspace {
  let groups = layout.groups.filter(g => g.tabs.length)
  if (!groups.some(g => !g.window)) {
    const fallback = startTab(), id = `editor-${crypto.randomUUID()}`
    w = { ...w, tabs: [...w.tabs, fallback] }; groups = [{ id, tabs: [fallback.id], active: fallback.id }, ...groups]
    layout = { ...layout, root: leaf(id) }
  }
  const ids = new Set(groups.filter(g => !g.window).map(g => g.id))
  const current = groups.find(g => g.tabs.includes(active)) ?? groups[0]
  const selected = current.tabs.includes(active) ? active : current.active
  return { ...w, active: selected, editors: { ...layout, root: prune(layout.root, ids)!, groups: groups.map(g => g.id === current.id ? { ...g, active: selected } : g), recent: [current.id, ...layout.recent.filter(id => id !== current.id && groups.some(g => g.id === id))] } }
}
export function activateEditor(w: Workspace, id: string): Workspace {
  if (w.active === id || !w.tabs.some(t => t.id === id)) return w
  return finish(w, editorsOf(w), id)
}
export function insertEditor(w: Workspace, entry: TabEntry, target?: string): Workspace {
  const e = editorsOf(w), group = e.groups.find(g => g.id === target) ?? groupOf(w)!
  const ids = [...group.tabs]; ids.splice(ids.indexOf(group.active) + 1, 0, entry.id)
  return finish({ ...w, tabs: [...w.tabs, entry] }, { ...e, groups: e.groups.map(g => g.id === group.id ? { ...g, tabs: ids } : g) }, entry.id)
}
export function replaceEditor(w: Workspace, id: string, entry: TabEntry): Workspace {
  const e = editorsOf(w)
  return finish({ ...w, tabs: w.tabs.map(t => t.id === id ? entry : t) }, { ...e, groups: e.groups.map(g => ({ ...g, tabs: g.tabs.map(t => t === id ? entry.id : t), active: g.active === id ? entry.id : g.active })) }, w.active === id ? entry.id : w.active)
}
export function closeEditor(w: Workspace, id: string, fallback: TabEntry): Workspace {
  if (!w.tabs.some(t => t.id === id)) return w
  const tabs = w.tabs.filter(t => t.id !== id), e = editorsOf(w)
  if (!tabs.length) return { ...w, tabs: [fallback], active: fallback.id, editors: readEditors(undefined, [fallback], fallback.id) }
  const groups = e.groups.map(g => { const ids = g.tabs.filter(t => t !== id); return { ...g, tabs: ids, active: g.active === id ? ids[Math.min(g.tabs.indexOf(id), ids.length - 1)] : g.active } })
  const source = groups.find(g => g.id === groupOf(w, id)?.id)
  return finish({ ...w, tabs }, { ...e, groups }, w.active === id ? source?.active : w.active)
}
export function splitEditors(w: Workspace, edge: EditorEdge, entry: TabEntry, target = groupOf(w)!.id): Workspace {
  const e = editorsOf(w)
  if (!e.groups.some(g => g.id === target && !g.window)) return w
  const id = `editor-${crypto.randomUUID()}`, before = edge === 'left' || edge === 'top'
  const root = mapNode(e.root, n => n.type === 'group' && n.id === target ? { type: 'split', id: `split-${crypto.randomUUID()}`, direction: edge === 'left' || edge === 'right' ? 'columns' : 'rows', ratio: 0.5, first: before ? leaf(id) : n, second: before ? n : leaf(id) } : n)
  return finish({ ...w, tabs: [...w.tabs, entry] }, { ...e, root, groups: [...e.groups, { id, tabs: [entry.id], active: entry.id }] }, entry.id)
}
export function joinEditors(w: Workspace, source?: string, target?: string): Workspace {
  const e = editorsOf(w)
  if (source && target) {
    const a = e.groups.find(g => g.id === source), b = e.groups.find(g => g.id === target)
    if (!a || !b || a === b) return w
    return finish(w, { ...e, groups: e.groups.filter(g => g !== a).map(g => g === b ? { ...g, tabs: [...g.tabs, ...a.tabs] } : g) })
  }
  const id = e.groups.find(g => g.id === groupOf(w)?.id && !g.window)?.id ?? nodeGroups(e.root)[0]
  return finish(w, { ...e, root: leaf(id), groups: [{ id, tabs: nodeGroups(e.root).flatMap(id => e.groups.find(g => g.id === id)!.tabs), active: e.groups.find(g => g.id === id)!.active }, ...e.groups.filter(g => g.window)] })
}
export function moveEditor(w: Workspace, id: string, target: string, before?: string): Workspace {
  const e = editorsOf(w)
  if (!groupOf(w, id) || !e.groups.some(g => g.id === target) || id === before) return w
  const groups = e.groups.map(g => { const ids = g.tabs.filter(t => t !== id); if (g.id === target) { const i = before ? ids.indexOf(before) : -1; ids.splice(i < 0 ? ids.length : i, 0, id) } return { ...g, tabs: ids, active: g.active === id ? ids[Math.min(g.tabs.indexOf(id), ids.length - 1)] : g.active } })
  return finish(w, { ...e, groups }, id)
}
export function splitMoveEditor(w: Workspace, id: string, target: string, edge: EditorEdge, placeholder: TabEntry): Workspace {
  const source = groupOf(w, id)
  if (!source) return w
  // 拖走本组唯一标签时，用开始页保留原区域；被拖动的页面实例随标签移入新组。
  const keepSource = source.id === target && source.tabs.length === 1
  const prepared = keepSource ? insertEditor(w, placeholder, target) : w
  const temporary = keepSource ? { ...placeholder, id: placeholder.id + '-split' } : placeholder
  const split = splitEditors(prepared, edge, temporary, target)
  if (split === prepared) return w
  const moved = moveEditor(split, id, groupOf(split, temporary.id)!.id)
  return closeEditor(moved, temporary.id, placeholder)
}
export const resizeEditors = (w: Workspace, id: string, ratio: number): Workspace => Number.isFinite(ratio) ? { ...w, editors: { ...editorsOf(w), root: mapNode(editorsOf(w).root, n => n.type === 'split' && n.id === id ? { ...n, ratio: clamp(ratio) } : n) } } : w
export const balanceEditors = (w: Workspace): Workspace => ({ ...w, editors: { ...editorsOf(w), root: mapNode(editorsOf(w).root, n => n.type === 'split' ? { ...n, ratio: 0.5 } : n) } })
export interface EditorOpenTarget { window?: import('../../plugin-api/ui/contracts').PageWindowTarget; group?: string; originGroup?: string; placement?: 'current' | 'other'; destination?: string; origin?: string; instance?: 'new' }
/** 打开决策与提交共用目标解析，保留 other 的相邻组回退和必要时新分组规则。 */
export function resolveEditorOpenTarget(w: Workspace, target: EditorOpenTarget) {
  const layout = editorsOf(w), source = openGroup(layout, { ...target, group: target.group ?? (target.placement ? target.originGroup : undefined) })
  const destination = target.placement === 'other' ? layout.groups.find(g => g.id === target.destination && g.id !== source.id) ?? otherGroup(layout, source.id) : source
  return { source, destination }
}
export function openEditor(w: Workspace, entry: TabEntry, target: EditorOpenTarget, existingId: string | undefined, fallback: TabEntry): Workspace {
  const existing = w.tabs.find(t => t.id === existingId), page = existing ? { ...existing, params: { ...existing.params, ...entry.params } } : entry
  const base = existing ? { ...w, tabs: w.tabs.map(t => t.id === page.id ? page : t) } : w
  if (existing && !target.placement) return activateEditor(base, page.id)
  const { source, destination } = resolveEditorOpenTarget(base, target)
  if (destination) return !existing ? insertEditor(base, page, destination.id) : destination.tabs.includes(page.id) ? activateEditor(base, page.id) : moveEditor(base, page.id, destination.id)
  if (!existing) return splitEditors(base, 'right', page, source.id)
  return splitMoveEditor(base, page.id, source.id, 'right', fallback)
}
export function editorMinimum(n: EditorNode): { width: number; height: number } {
  if (n.type === 'group') return EDITOR_MIN
  const a = editorMinimum(n.first), b = editorMinimum(n.second)
  return n.direction === 'columns' ? { width: a.width + b.width + EDITOR_GAP, height: Math.max(a.height, b.height) } : { width: Math.max(a.width, b.width), height: a.height + b.height + EDITOR_GAP }
}
export interface EditorRect { x: number; y: number; width: number; height: number }
export function editorGeometry(root: EditorNode, width: number, height: number, compact = false) {
  const minimum = compact && root.type === 'group' ? { width: 0, height: 0 } : editorMinimum(root), groups = new Map<string, EditorRect>(), splits: { node: Extract<EditorNode, { type: 'split' }>; rect: EditorRect; ratio: number; min: number; max: number; size: number }[] = []
  const walk = (n: EditorNode, r: EditorRect) => {
    if (n.type === 'group') { groups.set(n.id, r); return }
    const columns = n.direction === 'columns', size = (columns ? r.width : r.height) - EDITOR_GAP
    const a = editorMinimum(n.first), b = editorMinimum(n.second), min = (columns ? a.width : a.height) / size, max = 1 - (columns ? b.width : b.height) / size
    const ratio = Math.max(min, Math.min(max, n.ratio)), first = size * ratio, second = size - first
    splits.push({ node: n, rect: columns ? { x: r.x + first, y: r.y, width: EDITOR_GAP, height: r.height } : { x: r.x, y: r.y + first, width: r.width, height: EDITOR_GAP }, ratio, min, max, size })
    walk(n.first, { ...r, [columns ? 'width' : 'height']: first })
    walk(n.second, columns ? { ...r, x: r.x + first + EDITOR_GAP, width: second } : { ...r, y: r.y + first + EDITOR_GAP, height: second })
  }
  width = Math.max(width, minimum.width); height = Math.max(height, minimum.height)
  walk(root, { x: 0, y: 0, width, height })
  return { groups, splits, width, height }
}
export const canSplitEditor = (r: EditorRect, edge: EditorEdge) => edge === 'left' || edge === 'right' ? r.width >= EDITOR_MIN.width * 2 + EDITOR_GAP : r.height >= EDITOR_MIN.height * 2 + EDITOR_GAP

/** 窗口只是普通组的显示位置；成员、活动页与实例规则仍由同一个布局持有。 */
export function detachEditor(w: Workspace, id: string, groupId: string, bounds: Partial<ContentWindowState> = {}, before = editorsOf(w)): Workspace {
  const layout = editorsOf(w), source = layout.groups.find(g => g.tabs.includes(id))
  if (!source || layout.groups.some(g => g.id === groupId)) return w
  const tabs = source.tabs.filter(t => t !== id)
  // 准备浮窗时可能已临时激活目标页；保留原来显示的页。移走它本身时，按关闭标签的顺序选邻页。
  const previous = before.groups.find(g => g.id === source.id)?.active
  const active = previous && tabs.includes(previous) ? previous : tabs[Math.min(source.tabs.indexOf(id), tabs.length - 1)]
  const groups = layout.groups.map(g => g === source ? { ...g, tabs, active } : g)
  return finish(w, { ...layout, groups: [...groups, { id: groupId, tabs: [id], active: id, window: bounds }] }, id)
}
export function returnEditorWindow(w: Workspace, groupId: string): Workspace {
  const layout = editorsOf(w), source = layout.groups.find(g => g.id === groupId && g.window)
  const target = layout.groups.find(g => !g.window)
  if (!source || !target) return w
  return joinEditors(w, source.id, target.id)
}
/** 预设只编排主窗口；浮动内容仍计入复用/数量检查，但不被重新分配。 */
export function mainWorkspace(w: Workspace): Workspace {
  const e = editorsOf(w), groups = e.groups.filter(g => !g.window), ids = new Set(groups.flatMap(g => g.tabs))
  return { ...w, tabs: w.tabs.filter(t => ids.has(t.id)), active: ids.has(w.active) ? w.active : groups[0].active, editors: { ...e, groups, recent: e.recent.filter(id => groups.some(g => g.id === id)) } }
}
export function mergeFloatingWorkspace(original: Workspace, main: Workspace): Workspace {
  const groups = editorsOf(original).groups.filter(g => g.window), ids = new Set(groups.flatMap(g => g.tabs))
  const e = editorsOf(main)
  let sidebars = main.sidebars
  for (const t of original.tabs) { const tool = ids.has(t.id) && toolIdOf(t); if (sidebars && tool) sidebars = takeToolFromSidebar(sidebars, tool) }
  return { ...main, sidebars, tabs: [...main.tabs.filter(t => !ids.has(t.id)), ...original.tabs.filter(t => ids.has(t.id))], active: ids.has(original.active) ? original.active : main.active,
    editors: { ...e, groups: [...e.groups, ...groups], recent: [...e.recent, ...groups.map(g => g.id)] } }
}
