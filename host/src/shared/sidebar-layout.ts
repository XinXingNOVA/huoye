/** 本机侧栏：纵向标签组与智能工具容器。未知工具与关闭工具保留位置，停用不重排。 */
export type SidebarSide = 'left' | 'right'
export interface ContainerDefault { id: string; side: SidebarSide }
export interface ViewDefault { id: string; container: string }
export interface BoundTool { toolId: string; pageId: string; pageType: string; title: string; pageTitle: string }
export interface ContextToolPreferences { tools: string[]; active?: string }
export interface SidebarContainer extends ContainerDefault {
  type: 'tabs' | 'context'
  views: string[]
  active: string
  /** 智能容器独立关闭，工具组合按主页面类型保存；不保存能力对象或页面 ID。 */
  closed?: boolean
  contexts?: Record<string, ContextToolPreferences>
}
export interface SidebarLayout {
  version: 4
  containers: SidebarContainer[]
  /** 固定工具身份，与侧栏／中央位置独立；本机工作区读取时清理无位置的身份，预设不携带绑定。 */
  bindings?: Record<string, BoundTool>
  /** 最近操作组，不决定其他组的可见性。 */
  selected: Partial<Record<SidebarSide, string>>
  hidden: string[]
  /** 组高度权重。 */
  weights: Record<string, number>
}
const idOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 200
const sideOk = (v: unknown): v is SidebarSide => v === 'left' || v === 'right'
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** v1 只在读取边界转换；v2 普通组同样只在边界升级；日常运行只有 v4。 */
export function readSidebars(raw: unknown): SidebarLayout | undefined {
  const r = record(raw)
  if ((r.version !== 1 && r.version !== 2 && r.version !== 3 && r.version !== 4) || !Array.isArray(r.containers)) return
  const containers: SidebarContainer[] = [], ids = new Set<string>(), views = new Set<string>()
  for (const value of r.containers.slice(0, 500)) {
    const c = record(value)
    if (!idOk(c.id) || ids.has(c.id) || !sideOk(c.side) || !Array.isArray(c.views) || (r.version !== 1 && c.type !== 'tabs' && !((r.version === 3 || r.version === 4) && c.type === 'context'))) continue
    ids.add(c.id)
    if ((r.version === 3 || r.version === 4) && c.type === 'context') {
      const contexts = Object.fromEntries(Object.entries(record(c.contexts)).slice(0, 200).flatMap(([type, raw]) => {
        const prefs = record(raw)
        if (!idOk(type) || !Array.isArray(prefs.tools)) return []
        const tools = [...new Set(prefs.tools.filter(idOk))].slice(0, 200)
        return [[type, { tools, ...(idOk(prefs.active) ? { active: prefs.active } : {}) }]]
      }))
      containers.push({ id: c.id, side: c.side, type: 'context', views: [], active: '', closed: c.closed === true, contexts }); continue
    }
    const members = c.views.slice(0, 500).filter((id): id is string => {
      if (!idOk(id) || views.has(id)) return false
      views.add(id); return true
    })
    if (members.length) containers.push({ id: c.id, side: c.side, type: 'tabs', views: members, active: idOk(c.active) && members.includes(c.active) ? c.active : members[0] })
  }
  const selected = Object.fromEntries(Object.entries(record(r.selected)).filter(([side, id]) => sideOk(side) && idOk(id) && containers.some(c => c.id === id && c.side === side)))
  const weights = Object.fromEntries(Object.entries(record(r.weights)).filter(([id, w]) => idOk(id) && typeof w === 'number' && Number.isFinite(w) && w >= 0.05 && w <= 100)) as Record<string, number>
  const bindings = Object.fromEntries(Object.entries(record(r.bindings)).slice(0, 128).flatMap(([id, raw]) => {
    const b = record(raw)
    if (r.version !== 4 || !id.startsWith('bound:') || !idOk(id) || (![b.toolId, b.pageId, b.pageType].every(idOk) || ![b.title, b.pageTitle].every(v => typeof v === 'string' && v.length > 0 && v.length <= 1000))) return []
    return [[id, { toolId: b.toolId, pageId: b.pageId, pageType: b.pageType, title: b.title, pageTitle: b.pageTitle }]]
  })) as Record<string, BoundTool>
  if (r.version !== 1) {
    const result: SidebarLayout = {
      version: 4, containers, selected, ...(Object.keys(bindings).length ? { bindings } : {}), weights: Object.fromEntries(Object.entries(weights).filter(([id]) => containers.some(c => c.id === id))),
      hidden: Array.isArray(r.hidden) ? [...new Set(r.hidden.filter((id): id is string => idOk(id) && views.has(id)))] : []
    }
    return r.version >= 3 ? result : seedContextContainer(result)
  }
  const hidden = new Set<string>(), migrated: SidebarContainer[] = [], sizes: Record<string, number> = {}
  let extraGroups = 500 - containers.length
  const collapsed = new Set(Array.isArray(r.collapsed) ? r.collapsed.filter(idOk) : [])
  for (const side of ['left', 'right'] as const) {
    const rows = containers.filter(c => c.side === side)
    const chosen = rows.find(c => c.id === selected[side]) ?? rows[0]
    for (const c of rows) {
      if (c !== chosen) { migrated.push(c); c.views.forEach(id => hidden.add(id)); continue }
      const expanded = c.views.filter(id => !collapsed.has(id))
      const first = expanded[0] ?? c.views[0]
      migrated.push({ ...c, views: [first, ...c.views.filter(id => id !== first && collapsed.has(id))], active: first })
      for (const id of c.views) if (collapsed.has(id)) hidden.add(id)
      sizes[c.id] = weights[first] ?? 1
      const primary = migrated[migrated.length - 1]
      for (const [i, id] of expanded.slice(1).entries()) {
        if (!extraGroups) { primary.views.push(id); continue }
        extraGroups--
        let group = `migrated-${migrated.length}-${i}`
        while (ids.has(group)) group += '-s'
        ids.add(group); migrated.push({ id: group, side, type: 'tabs', views: [id], active: id }); sizes[group] = weights[id] ?? 1
      }
      selected[side] = c.id
    }
  }
  return seedContextContainer({ version: 4, containers: migrated, selected, hidden: [...hidden], weights: sizes })
}

/** 导航与分面拆分的确定映射：在原导航之后放智能组，保留其侧和关闭选择。 */
export function seedContextContainer(layout: SidebarLayout): SidebarLayout {
  if (layout.containers.some(c => c.type === 'context')) return layout
  const at = layout.containers.findIndex(c => c.views.includes('host.navigation'))
  if (at < 0) return layout
  const nav = layout.containers[at], containers = [...layout.containers]
  let id = 'host.context'
  while (containers.some(c => c.id === id)) id += '-s'
  containers.splice(at + 1, 0, { id, type: 'context', side: nav.side, views: [], active: '', closed: layout.hidden.includes('host.navigation'), contexts: {} })
  const weight = layout.weights[nav.id] ?? 1
  return { ...layout, containers, weights: { ...layout.weights, [nav.id]: Math.max(.05, weight * .6), [id]: Math.max(.05, weight * .4) } }
}

/** 预设只携带布局和组合，不捕获某个工作区的页面绑定。 */
export function withoutBoundTools(layout: SidebarLayout): SidebarLayout {
  const bound = new Set(Object.keys(layout.bindings ?? {}))
  const { bindings: _, ...rest } = layout
  const containers = layout.containers.map(c => {
    const views = c.views.filter(id => !bound.has(id) && !id.startsWith('bound:'))
    return { ...c, views, active: views.includes(c.active) ? c.active : views[0] ?? '' }
  }).filter(c => c.type === 'context' || c.views.length)
  const ids = new Set(containers.map(c => c.id))
  return { ...rest, containers, hidden: layout.hidden.filter(id => !bound.has(id)),
    weights: Object.fromEntries(Object.entries(layout.weights).filter(([id]) => ids.has(id))),
    selected: Object.fromEntries(Object.entries(layout.selected).filter(([, id]) => ids.has(id!))) }
}
