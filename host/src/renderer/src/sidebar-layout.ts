import { seedContextContainer, readSidebars, type SidebarSide, type SidebarLayout, type SidebarContainer, type ContainerDefault, type ViewDefault } from '../../shared/sidebar-layout'
import { findBoundTool } from './context-tools'
export { readSidebars } from '../../shared/sidebar-layout'
export type { SidebarSide, SidebarLayout, SidebarContainer, ContainerDefault, ViewDefault } from '../../shared/sidebar-layout'

export function reconcileSidebars(raw: unknown, defaults: ContainerDefault[], views: ViewDefault[], legacy?: Partial<Record<SidebarSide, string>>): SidebarLayout {
  const layout: SidebarLayout = readSidebars(raw) ?? { version: 4, containers: [], selected: {}, hidden: [], weights: {} }
  for (const view of views) {
    if (layout.containers.some(c => c.views.includes(view.id))) continue
    let target = layout.containers.find(c => c.id === view.container)
    if (!target) {
      const def = defaults.find(c => c.id === view.container)
      if (!def) continue
      const occupied = layout.containers.some(c => c.side === def.side && c.views.some(id => !layout.hidden.includes(id)))
      target = { id: def.id, side: def.side, type: 'tabs', views: [], active: view.id }; layout.containers.push(target)
      if (occupied) layout.hidden.push(view.id)
    } else if (target.views.every(id => layout.hidden.includes(id))) layout.hidden.push(view.id)
    target.views.push(view.id)
  }
  for (const side of ['left', 'right'] as const) {
    if (!raw && legacy?.[side]) {
      const target = layout.containers.find(c => c.views.includes(legacy[side]!))
      if (target) {
        for (const c of layout.containers.filter(c => c.side === side)) for (const id of c.views) {
          layout.hidden = layout.hidden.filter(v => v !== id)
          if (c !== target) layout.hidden.push(id)
        }
        layout.selected[side] = target.id; target.active = legacy[side]!
      }
    }
    const first = availableContainers(layout, views, side)[0]?.id
    if (!raw && !layout.selected[side] && first) layout.selected[side] = first
  }
  return raw ? layout : seedContextContainer(layout)
}

export function groupViews(layout: SidebarLayout, c: SidebarContainer, views: readonly Pick<ViewDefault, 'id'>[]) {
  const known = new Set(views.map(v => v.id))
  return c.type === 'context' ? [] : c.views.filter(id => known.has(id) && !layout.hidden.includes(id))
}
export function availableContainers(layout: SidebarLayout, views: readonly Pick<ViewDefault, 'id'>[], side?: SidebarSide): SidebarContainer[] {
  return layout.containers.filter(c => (!side || c.side === side) && (c.type === 'context' ? !c.closed : groupViews(layout, c, views).length))
}
export function activeView(layout: SidebarLayout, c: SidebarContainer, views: readonly Pick<ViewDefault, 'id'>[]): string | undefined {
  const ids = groupViews(layout, c, views)
  return ids.includes(c.active) ? c.active : ids[0]
}
export function revealView(layout: SidebarLayout, id: string): SidebarLayout {
  const c = layout.containers.find(c => c.views.includes(id))
  return c ? { ...layout, selected: { ...layout.selected, [c.side]: c.id }, hidden: layout.hidden.filter(v => v !== id),
    containers: layout.containers.map(g => g.id === c.id ? { ...g, active: id } : g) } : layout
}
export function closeView(layout: SidebarLayout, id: string): SidebarLayout {
  return layout.hidden.includes(id) || !layout.containers.some(c => c.views.includes(id)) ? layout : { ...layout, hidden: [...layout.hidden, id] }
}
function clean(layout: SidebarLayout): SidebarLayout {
  const containers = layout.containers.filter(c => c.type === 'context' || c.views.length).map(c => c.type === 'context' || c.views.includes(c.active) ? c : { ...c, active: c.views[0] })
  return { ...layout, containers, selected: Object.fromEntries(Object.entries(layout.selected).filter(([side, id]) => containers.some(c => c.id === id && c.side === side))), weights: Object.fromEntries(Object.entries(layout.weights).filter(([id]) => containers.some(c => c.id === id))) }
}
export function moveView(layout: SidebarLayout, id: string, target: string, before?: string): SidebarLayout {
  if (id === before || !layout.containers.some(c => c.views.includes(id)) || !layout.containers.some(c => c.id === target && c.type === 'tabs')) return layout
  const containers = layout.containers.map(c => ({ ...c, views: c.views.filter(v => v !== id) }))
  const to = containers.find(c => c.id === target)!
  const index = before ? to.views.indexOf(before) : -1
  to.views.splice(index < 0 ? to.views.length : index, 0, id)
  return clean(revealView({ ...layout, containers }, id))
}
/** 合并组只移动成员；关闭的工具不因整组操作被重新打开。 */
export function mergeContainers(layout: SidebarLayout, source: string, target: string, before?: string): SidebarLayout {
  const from = layout.containers.find(c => c.id === source), to = layout.containers.find(c => c.id === target)
  if (!from || !to || from.type !== 'tabs' || to.type !== 'tabs' || source === target) return layout
  const active = !layout.hidden.includes(from.active) ? from.active : from.views.find(id => !layout.hidden.includes(id))
  const merged = from.views.reduce((next, id) => moveView(next, id, target, before), layout)
  return { ...merged, hidden: layout.hidden, containers: merged.containers.map(c => c.id === target ? { ...c, active: active ?? to.active } : c) }
}
export function separateView(layout: SidebarLayout, id: string, side: SidebarSide, before?: string): SidebarLayout {
  const source = layout.containers.find(c => c.views.includes(id))
  if (!source) return layout
  if (source.views.length === 1) return revealView(moveContainer(layout, source.id, side, before), id)
  const base = `view:${id.slice(0, 170)}`
  let target = base, suffix = 1
  while (layout.containers.some(c => c.id === target)) target = `${base}:${suffix++}`
  const containers = [...layout.containers, { id: target, side, type: 'tabs' as const, views: [], active: id }]
  return moveContainer(moveView({ ...layout, containers }, id, target), target, side, before)
}
export function moveContainer(layout: SidebarLayout, id: string, side: SidebarSide, before?: string): SidebarLayout {
  const source = layout.containers.find(c => c.id === id)
  if (!source || id === before) return layout
  const containers = layout.containers.filter(c => c.id !== id)
  const index = before ? containers.findIndex(c => c.id === before && c.side === side) : -1
  containers.splice(index < 0 ? containers.length : index, 0, { ...source, side })
  return clean({ ...layout, containers, selected: { ...layout.selected, [side]: id } })
}
export function resetView(layout: SidebarLayout, id: string, defaults: ContainerDefault[], views: ViewDefault[]): SidebarLayout {
  const view = views.find(v => v.id === id), def = defaults.find(c => c.id === view?.container)
  if (!def) return layout
  const containers = layout.containers.some(c => c.id === def.id) ? layout.containers : [...layout.containers, { id: def.id, side: def.side, type: 'tabs' as const, views: [], active: id }]
  return moveView({ ...layout, containers }, id, def.id)
}

export function addContextContainer(layout: SidebarLayout, side: SidebarSide): SidebarLayout {
  const id = `context:${crypto.randomUUID()}`
  return { ...layout, containers: [...layout.containers, { id, side, type: 'context', views: [], active: '', closed: false, contexts: {} }], selected: { ...layout.selected, [side]: id } }
}
export function revealContextContainer(layout: SidebarLayout): SidebarLayout {
  const c = layout.containers.find(c => c.type === 'context' && !c.closed) ?? layout.containers.find(c => c.type === 'context')
  return c ? { ...layout, selected: { ...layout.selected, [c.side]: c.id }, containers: layout.containers.map(g => g.id === c.id ? { ...g, closed: false } : g) } : addContextContainer(layout, 'left')
}

export const sidebarMinHeight = (c: Pick<SidebarContainer, 'type'>) => c.type === 'context' ? 190 : 120

/** 显式关闭固定实例会释放它；普通工具继续使用隐藏／重开。 */
export function removeBoundTool(layout: SidebarLayout, id: string): SidebarLayout {
  if (!layout.bindings?.[id]) return layout
  const bindings = { ...layout.bindings }; delete bindings[id]
  const next = clean({ ...layout, containers: layout.containers.map(c => ({ ...c, views: c.views.filter(v => v !== id) })), hidden: layout.hidden.filter(v => v !== id) })
  delete next.bindings
  return Object.keys(bindings).length ? { ...next, bindings } : next
}
/** 同工具＋同页面复用；落点通过统一普通组动作处理。调用方提交前校验能力和数量。 */
export function placeBoundTool(layout: SidebarLayout, binding: import('../../shared/sidebar-layout').BoundTool, side: SidebarSide, target?: string, before?: string): SidebarLayout {
  if (target && !layout.containers.some(c => c.id === target && c.type === 'tabs' && c.side === side)) return layout
  const existing = findBoundTool(layout, binding)
  const id = existing ?? `bound:${crypto.randomUUID()}`
  let next = layout
  if (!existing) {
    const group = `view:${id}`
    next = { ...layout, bindings: { ...layout.bindings, [id]: binding }, containers: [...layout.containers, { id: group, side, type: 'tabs', views: [id], active: id }] }
  }
  return putToolInSidebar(next, id, side, target, before)
}
/** 应用布局预设保留真实固定工具，不用预设中的页面身份重建或改绑。 */
export function retainBoundTools(next: SidebarLayout, current: SidebarLayout): SidebarLayout {
  if (!current.bindings) return next
  const containers = [...next.containers], weights = { ...next.weights }
  for (const source of current.containers) {
    const views = source.views.filter(id => current.bindings?.[id])
    if (!views.length) continue
    const index = containers.findIndex(c => c.id === source.id && c.type === 'tabs')
    if (index >= 0) containers[index] = { ...containers[index], views: [...containers[index].views, ...views] }
    else {
      let id = source.id
      while (containers.some(c => c.id === id)) id += '-bound'
      containers.push({ ...source, id, views, active: views.includes(source.active) ? source.active : views[0] })
      weights[id] = current.weights[source.id] ?? 1
    }
  }
  return { ...next, containers, weights, bindings: current.bindings, hidden: [...next.hidden, ...current.hidden.filter(id => current.bindings?.[id])] }
}

/** 位置转移不释放固定身份。中央和侧栏只能有一个位置记录。 */
export function takeToolFromSidebar(layout: SidebarLayout, id: string): SidebarLayout {
  return clean({ ...layout, containers: layout.containers.map(c => ({ ...c, views: c.views.filter(v => v !== id) })), hidden: layout.hidden.filter(v => v !== id) })
}
export function putToolInSidebar(layout: SidebarLayout, id: string, side: SidebarSide, target?: string, before?: string): SidebarLayout {
  if (target && !layout.containers.some(c => c.id === target && c.type === 'tabs' && c.side === side)) return layout
  let next = layout
  if (!next.containers.some(c => c.views.includes(id))) {
    let group = `view:${id}`
    while (next.containers.some(c => c.id === group)) group += '-s'
    next = { ...next, containers: [...next.containers, { id: group, side, type: 'tabs', views: [id], active: id }] }
  }
  return target ? moveView(next, id, target, before) : separateView(next, id, side, before)
}
