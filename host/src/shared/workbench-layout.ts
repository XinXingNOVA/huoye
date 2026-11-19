import { layoutRecord } from './browsing-layout'
import { withoutBoundTools, readSidebars, type SidebarLayout } from './sidebar-layout'
export type WorkbenchNode = { type: 'group'; id: string } | { type: 'split'; id: string; direction: 'columns' | 'rows'; ratio: number; first: WorkbenchNode; second: WorkbenchNode }
/** 可分享的内容入口；target / presentation 由页面显式编码，不能装入整个页面存档。 */
export type WorkbenchSurface =
  | { kind: 'page'; type: string; target: Record<string, unknown>; presentation?: Record<string, unknown> }
  | { kind: 'tool'; id: string }
export interface WorkbenchContents { items: WorkbenchSurface[]; active?: number }
/** 分割树只管几何；contents 按叶子 ID 声明内容，不包含运行时页面 ID。 */
export interface WorkbenchLayout {
  version: 1
  root: WorkbenchNode
  primary: string
  panels: { sidebar: boolean; inspector: boolean }
  panelSizes?: Partial<Record<'sidebar' | 'inspector', number>>
  sidebars?: SidebarLayout
  contents?: Record<string, WorkbenchContents>
}
export const PANEL_LIMITS = { sidebar: { min: 176, max: 360, initial: 220 }, inspector: { min: 240, max: 480, initial: 300 } }
const group = (id: string): WorkbenchNode => ({ type: 'group', id })
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('布局格式不正确')
  return value as Record<string, unknown>
}
export const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100
export function readWorkbenchLayout(raw: unknown): WorkbenchLayout {
  const value = object(raw), used = new Set<string>(), leaves = new Set<string>()
  const read = (raw: unknown, depth = 0): WorkbenchNode => {
    const n = object(raw)
    if (depth > 64 || used.size >= 127) throw new Error('布局过于复杂，最多保存 64 个区域')
    if (!validId(n.id) || used.has(n.id)) throw new Error('布局区域标识无效或重复')
    used.add(n.id)
    if (n.type === 'group') { leaves.add(n.id); return group(n.id) }
    if (n.type !== 'split' || !['columns', 'rows'].includes(String(n.direction)) || typeof n.ratio !== 'number' || !Number.isFinite(n.ratio) || n.ratio <= 0 || n.ratio >= 1) throw new Error('布局分隔比例或方向无效')
    return { type: 'split', id: n.id, direction: n.direction as 'columns' | 'rows', ratio: n.ratio, first: read(n.first, depth + 1), second: read(n.second, depth + 1) }
  }
  if (value.version !== 1) throw new Error('不支持此布局版本')
  const root = read(value.root), panels = object(value.panels)
  if (!validId(value.primary) || !leaves.has(value.primary) || typeof panels.sidebar !== 'boolean' || typeof panels.inspector !== 'boolean') throw new Error('布局主区域或侧栏配置无效')
  const panelSizes: WorkbenchLayout['panelSizes'] = {}
  if (value.panelSizes !== undefined) {
    const sizes = object(value.panelSizes)
    for (const side of ['sidebar', 'inspector'] as const) if (sizes[side] !== undefined) {
      const n = sizes[side], limit = PANEL_LIMITS[side]
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('侧栏宽度无效')
      panelSizes[side] = Math.max(limit.min, Math.min(limit.max, n))
    }
  }
  const sidebars = value.sidebars === undefined ? undefined : readSidebars(value.sidebars)
  if (value.sidebars !== undefined && !sidebars) throw new Error('侧栏布局无效')
  const contents: Record<string, WorkbenchContents> = {}
  let count = 0
  if (value.contents !== undefined) for (const [id, raw] of Object.entries(object(value.contents))) {
    const c = object(raw)
    if (!leaves.has(id) || !Array.isArray(c.items) || (count += c.items.length) > 128) throw new Error('预设内容区域无效或超过 128 项')
    const items = c.items.map(readWorkbenchSurface)
    if (c.active !== undefined && (!Number.isInteger(c.active) || Number(c.active) < 0 || Number(c.active) >= items.length)) throw new Error('预设激活项无效')
    contents[id] = { items, ...(c.active === undefined ? {} : { active: Number(c.active) }) }
  }
  const toolPositions = new Set(sidebars?.containers.flatMap(c => c.views) ?? [])
  for (const slot of Object.values(contents)) for (const item of slot.items) if (item.kind === 'tool') {
    if (toolPositions.has(item.id)) throw new Error(`预设重复安排工具位置：${item.id}`)
    toolPositions.add(item.id)
  }
  return { version: 1, root, primary: value.primary, panels: { sidebar: panels.sidebar, inspector: panels.inspector },
    ...(value.panelSizes !== undefined ? { panelSizes } : {}), ...(sidebars ? { sidebars: withoutBoundTools(sidebars) } : {}), ...(value.contents === undefined ? {} : { contents }) }
}

export function readWorkbenchSurface(raw: unknown): WorkbenchSurface {
  const v = object(raw)
  const contentId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 150
  if (v.kind === 'tool' && contentId(v.id) && !v.id.startsWith('bound:')) return { kind: 'tool', id: v.id }
  if (v.kind === 'page' && contentId(v.type)) return { kind: 'page', type: v.type, target: layoutRecord(v.target),
    ...(v.presentation === undefined ? {} : { presentation: layoutRecord(v.presentation) }) }
  throw new Error('预设内容入口无效；固定页面绑定不能进入命名预设')
}
