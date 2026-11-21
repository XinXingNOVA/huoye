import { uiText } from '../../shared/i18n/interface-display'
import type { WorkbenchPresetPreview, WorkbenchSurfaceDescription } from '../../plugin-api/ui/workbench-presets'
import type { TabType } from '../../plugin-api/ui/contracts'
import { layoutRecord } from '../../shared/browsing-layout'
import { readWorkbenchLayout, readWorkbenchSurface, type WorkbenchLayout, type WorkbenchSurface } from '../../shared/workbench-layout'
import { sameValue } from './collection-query'
import { editorsOf, groupOf } from './editor-layout'
import { choosePage } from './page-instances'
import { takeToolFromSidebar, putToolInSidebar } from './sidebar-layout'
import type { SidebarCatalog } from './sidebar-types'
import { reconcileToolWorkspace } from './tool-docking'
import { contentPlacementReason, describeTools } from './workbench-content'
import { applyWorkbenchLayout, captureLayoutReturnPoint, captureWorkbenchLayout, type LayoutReturnPoint } from './workbench-presets'
import { newTabId, startTab, toolIdOf, toolTab, type TabEntry, type Workspace } from './workspace'

export interface ArrangementEnvironment { page(type: string): TabType<any, any> | undefined; catalog: SidebarCatalog; retained?: readonly TabEntry[] }
interface PresentationReturn { id: string; type: string; params: Record<string, unknown>; value: Record<string, unknown> }
export interface ArrangementReturnPoint extends LayoutReturnPoint { presentations: PresentationReturn[]; tools: { id: string; group: string }[] }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const placeholder = (t: TabEntry) => t.type === 'workspace.start' && t.params.layoutPlaceholder === true
const emptyPage = () => ({ ...startTab(), params: { layoutPlaceholder: true } })

function capturePage(entry: TabEntry, env: ArrangementEnvironment) {
  const adapter = env.page(entry.type)?.workbench
  const data = adapter?.capture(structuredClone(entry.params), structuredClone(entry.state))
  return data && readWorkbenchSurface({ ...data, kind: 'page', type: entry.type })
}
export function captureWorkbenchArrangement(w: Workspace, env: ArrangementEnvironment): WorkbenchLayout {
  const layout = captureWorkbenchLayout(w)
  const contents = Object.fromEntries(editorsOf(w).groups.flatMap(g => {
    const rows = g.tabs.flatMap(id => {
      const t = w.tabs.find(t => t.id === id)!, tool = toolIdOf(t)
      const item = tool ? !tool.startsWith('bound:') && env.catalog.views.some(v => v.id === tool) ? { kind: 'tool' as const, id: tool } : undefined : capturePage(t, env)
      return item ? [{ item, id }] : []
    })
    const active = rows.findIndex(r => r.id === g.active)
    return rows.length ? [[g.id, { items: rows.map(r => r.item), ...(active < 0 ? {} : { active }) }]] : []
  }))
  return readWorkbenchLayout({ ...layout, contents })
}

/** 预检与实际应用共用页面解码；单项故障不破坏其余编排。 */
function resolvePage(surface: Extract<WorkbenchSurface, { kind: 'page' }>, env: ArrangementEnvironment) {
  const rule = env.page(surface.type), adapter = rule?.workbench
  if (!rule || !adapter) throw new Error(uiText("{type} 页面未启用或未开放预设入口", { type: String(surface.type) }))
  const params = layoutRecord(adapter.resolve(structuredClone(surface.target)))
  // 不认可自动发生的业务身份转换；描述应由提供方规范化后稳定往返。
  const captured = adapter.capture(structuredClone(params), undefined)
  if (!captured) throw new Error(uiText("{type} 不支持此预设入口", { type: String(surface.type) }))
  if (surface.presentation !== undefined && !adapter.presentation) throw new Error(uiText("{type} 未开放呈现配置", { type: String(surface.type) }))
  return { rule, adapter, params, target: layoutRecord(captured.target) }
}
export function inspectWorkbenchArrangement(layout: WorkbenchLayout, env: ArrangementEnvironment): string[] {
  const issues: string[] = [], tools = env.catalog.views
  for (const c of layout.sidebars?.containers ?? []) {
    for (const id of c.views) {
      const tool = tools.find(t => t.id === id)
      const reason = tool ? contentPlacementReason({ kind: 'tool', regions: tool.placement?.regions ?? ['left', 'right'] }, c.side) : uiText("工具未启用")
      if (reason) issues.push(`${id}：${reason}`)
    }
    for (const prefs of Object.values(c.contexts ?? {})) for (const id of prefs.tools) {
      if (!env.catalog.contextTools.some(t => t.id === id)) issues.push(uiText("{id}：上下文工具未启用", { id }))
    }
  }
  for (const slot of Object.values(layout.contents ?? {})) for (const s of slot.items) {
    try {
      if (s.kind === 'page') {
        const { adapter, params } = resolvePage(s, env)
        if (s.presentation !== undefined) adapter.presentation!.apply(params, undefined, structuredClone(s.presentation))
      } else {
        const tool = tools.find(t => t.id === s.id)
        const reason = tool ? contentPlacementReason({ kind: 'tool', regions: tool.placement?.regions ?? ['left', 'right'] }, 'center') : uiText("工具未启用")
        if (reason) issues.push(`${s.id}：${reason}`)
      }
    } catch (e) { issues.push(errorText(e)) }
  }
  return [...new Set(issues)]
}

/** 预览只读声明；与应用共用校验，不调用页面组件，也不读取业务记录。 */
export function previewWorkbenchArrangement(layout: WorkbenchLayout, env: ArrangementEnvironment): WorkbenchPresetPreview {
  const issues = inspectWorkbenchArrangement(layout, env)
  const tools = [...env.catalog.views, ...env.catalog.contextTools].map(t => ({ id: t.id, title: t.title }))
  const contents = Object.fromEntries(Object.entries(layout.contents ?? {}).map(([id, slot]) => [id, slot.items.map((surface): WorkbenchSurfaceDescription => {
    if (surface.kind === 'tool') return { title: tools.find(t => t.id === surface.id)?.title ?? uiText("暂不可用的工具"), detail: tools.some(t => t.id === surface.id) ? uiText("工具面板") : surface.id }
    try {
      const { adapter, params } = resolvePage(surface, env)
      const description = adapter.describe?.(structuredClone(surface.target), structuredClone(surface.presentation))
      if (description && (typeof description.title !== 'string' || !description.title.trim() || (description.detail !== undefined && typeof description.detail !== 'string'))) throw new Error(uiText("预览描述必须包含文字标题"))
      return { title: description?.title ?? (typeof params.title === 'string' ? params.title : uiText("功能页面")),
        detail: description?.detail ?? (surface.presentation ? uiText("含显示配置") : undefined) }
    } catch (e) {
      const message = errorText(e)
      if (!issues.includes(message)) issues.push(uiText("{type} 的预览说明不可用：{message}", { type: String(surface.type), message }))
      return { title: uiText("无法预览的页面"), detail: surface.type }
    }
  })]))
  return { contents, tools, issues: [...new Set(issues)] }
}

/** 一次纯状态规划后提交。保留全部真实页面，内容解码器不拥有宿主／业务写入口。 */
export function arrangeWorkbench(before: Workspace, raw: WorkbenchLayout, env: ArrangementEnvironment, returning?: ArrangementReturnPoint) {
  const layout = readWorkbenchLayout(raw), issues = returning ? [] : inspectWorkbenchArrangement(layout, env)
  const point: ArrangementReturnPoint = { ...captureLayoutReturnPoint(before), presentations: [], tools: before.tabs.flatMap(t => {
    const id = toolIdOf(t)
    return id && !id.startsWith('bound:') ? [{ id, group: groupOf(before, t.id)!.id }] : []
  }) }
  // 已安装工具不能被旧／手写预设摆进其未声明的区域；保留原位置，未知工具继续保留占位。
  const safeLayout = { ...layout }
  if (safeLayout.sidebars) for (const c of layout.sidebars!.containers) for (const id of c.views) {
    const tool = describeTools(before, env.catalog).find(t => t.id === id)
    if (!tool || !contentPlacementReason(tool, c.side)) continue
    safeLayout.sidebars = takeToolFromSidebar(safeLayout.sidebars!, id)
    const original = before.sidebars?.containers.find(g => g.views.includes(id))
    if (original) {
      safeLayout.sidebars = putToolInSidebar(safeLayout.sidebars, id, original.side)
      if (before.sidebars?.hidden.includes(id)) safeLayout.sidebars.hidden.push(id)
    }
  }
  let next = applyWorkbenchLayout(before, safeLayout, returning?.groups)
  // 显式侧栏位置可接回中央普通工具；固定实例继续保留原绑定。
  const sideIds = new Set<string>()
  for (const c of layout.sidebars?.containers ?? []) for (const id of c.views) {
    const tool = describeTools(next, env.catalog).find(t => t.id === id)
    if (tool && !tool.binding && !contentPlacementReason(tool, c.side)) sideIds.add(id)
  }
  const removed = new Set(next.tabs.filter(t => sideIds.has(toolIdOf(t) ?? '')).map(t => t.id))
  let tabs = next.tabs.filter(t => !removed.has(t.id))
  let groups = editorsOf(next).groups.map(g => ({ ...g, tabs: g.tabs.filter(id => !removed.has(id)) }))
  const originalActive = new Map(groups.map(g => [g.id, g.active]))
  const occupied = new Set(groups.filter(g => g.tabs.some(id => !placeholder(tabs.find(t => t.id === id)!))).map(g => g.id))
  const claimed = new Set<string>()
  const sync = () => { next = { ...next, tabs, editors: { ...editorsOf(next), groups } } }
  const place = (entry: TabEntry, group: string) => {
    const found = tabs.some(t => t.id === entry.id)
    tabs = found ? tabs.map(t => t.id === entry.id ? entry : t) : [...tabs, entry]
    groups = groups.map(g => ({ ...g, tabs: [...g.tabs.filter(id => id !== entry.id), ...(g.id === group ? [entry.id] : [])] }))
    claimed.add(entry.id); sync()
  }
  const changePresentation = (entry: TabEntry, surface: Extract<WorkbenchSurface, { kind: 'page' }>) => {
    if (surface.presentation === undefined) return entry
    const codec = env.page(entry.type)?.workbench?.presentation
    if (!codec) throw new Error(uiText("{type} 未开放呈现配置", { type: String(entry.type) }))
    const value = layoutRecord(codec.capture(structuredClone(entry.params), structuredClone(entry.state)))
    const state = codec.apply(structuredClone(entry.params), structuredClone(entry.state), structuredClone(surface.presentation))
    if (sameValue(state, entry.state)) return entry
    if (before.tabs.some(t => t.id === entry.id)) point.presentations.push({ id: entry.id, type: entry.type, params: structuredClone(entry.params), value })
    return { ...entry, state, presentationRevision: (entry.presentationRevision ?? 0) + 1 }
  }
  if (!returning) for (const [group, slot] of Object.entries(layout.contents ?? {})) {
    const arranged: string[] = [], resolved: (string | undefined)[] = []
    for (const surface of slot.items) {
      try {
        let entry: TabEntry
        if (surface.kind === 'tool') {
          if (env.retained?.some(t => toolIdOf(t) === surface.id)) throw new Error(uiText("{id} 已在独立窗口中，保留原位置", { id: String(surface.id) }))
          const tool = describeTools(next, env.catalog).find(t => t.id === surface.id)
          const reason = contentPlacementReason(tool, 'center')
          if (!tool?.available || reason) throw new Error(`${surface.id}：${reason ?? uiText("工具未启用")}`)
          entry = tabs.find(t => toolIdOf(t) === surface.id) ?? toolTab(surface.id, tool.title)
          if (claimed.has(entry.id)) throw new Error(uiText("{title} 已安排在另一位置", { title: String(tool.title) }))
          if (next.sidebars) next = { ...next, sidebars: takeToolFromSidebar(next.sidebars, surface.id) }
        } else {
          const { rule, adapter, params, target } = resolvePage(surface, env)
          const candidates = tabs.filter(t => t.type === surface.type && !claimed.has(t.id)).sort((a, b) => Number(!groups.find(g => g.id === group)!.tabs.includes(a.id)) - Number(!groups.find(g => g.id === group)!.tabs.includes(b.id)))
          const match = candidates.find(t => sameValue(adapter.capture(structuredClone(t.params), structuredClone(t.state))?.target, target))
          const created: TabEntry = { id: newTabId(), type: surface.type, params }
          const alreadyAssigned = tabs.some(t => t.type === surface.type && claimed.has(t.id) && sameValue(adapter.capture(structuredClone(t.params), structuredClone(t.state))?.target, target))
          const decision = match ? { existing: match.id } : choosePage([...tabs, ...(env.retained ?? [])], created, rule, { newView: alreadyAssigned })
          if (decision.blocked) throw new Error(decision.blocked)
          if (decision.existing && env.retained?.some(t => t.id === decision.existing)) throw new Error(uiText("{type} 已在独立窗口中，保留原位置", { type: String(surface.type) }))
          entry = decision.existing ? tabs.find(t => t.id === decision.existing)! : created
          if (claimed.has(entry.id)) throw new Error(uiText("{type} 已安排在另一位置，实例规则不允许重复", { type: String(surface.type) }))
          // 实例上限可能返回不同身份的唯一页；不把它替换为预设目标。
          if (decision.existing && !sameValue(adapter.capture(structuredClone(entry.params), structuredClone(entry.state))?.target, target)) throw new Error(uiText("{type} 的现有实例正在展示其他内容，已保留", { type: String(surface.type) }))
          try { entry = changePresentation(entry, surface) } catch (e) { issues.push(errorText(e)) }
        }
        place(entry, group); arranged.push(entry.id); resolved.push(entry.id)
      } catch (e) { issues.push(errorText(e)); resolved.push(undefined) }
    }
    groups = groups.map(g => g.id !== group ? g : { ...g, tabs: [...arranged, ...g.tabs.filter(id => !arranged.includes(id))],
      active: occupied.has(group) ? originalActive.get(group)! : resolved[slot.active ?? 0] ?? arranged[0] ?? g.active })
    sync()
  }
  if (returning) {
    // 返回只接回仍打开的工具；用户已关闭的工具不复活。
    for (const t of returning.tools) {
      const live = tabs.find(page => toolIdOf(page) === t.id)
      const onSide = before.sidebars?.containers.some(c => c.views.includes(t.id)) && !before.sidebars?.hidden.includes(t.id)
      const tool = describeTools(next, env.catalog).find(v => v.id === t.id)
      if ((live || onSide) && tool && !contentPlacementReason(tool, 'center') && groups.some(g => g.id === t.group)) {
        if (next.sidebars) next = { ...next, sidebars: takeToolFromSidebar(next.sidebars, t.id) }
        place(live ?? toolTab(t.id, tool.title), t.group)
      }
    }
    for (const p of returning.presentations) {
      const t = tabs.find(t => t.id === p.id && t.type === p.type && sameValue(t.params, p.params))
      if (!t) continue
      try {
        const codec = env.page(t.type)?.workbench?.presentation
        if (!codec) continue
        const state = codec.apply(structuredClone(t.params), structuredClone(t.state), structuredClone(p.value))
        tabs = tabs.map(row => row.id === t.id ? { ...t, state, presentationRevision: (t.presentationRevision ?? 0) + 1 } : row)
      } catch (e) { issues.push(errorText(e)) }
    }
  }
  // 移动最后一页不删除预设分区；只有宿主生成的空占位允许回收。
  const discard = new Set<string>()
  groups = groups.map(g => {
    const real = g.tabs.filter(id => tabs.some(t => t.id === id && !placeholder(t)))
    if (real.length) for (const id of g.tabs) if (!real.includes(id)) discard.add(id)
    const ids = real.length ? real : g.tabs
    if (!ids.length) { const empty = emptyPage(); tabs.push(empty); ids.push(empty.id) }
    const previousGroup = returning?.groups.find(row => row.id === g.id)
    const ordered = previousGroup ? [...previousGroup.tabs.filter(id => ids.includes(id)), ...ids.filter(id => !previousGroup.tabs.includes(id))] : ids
    const preferred = previousGroup?.active ?? g.active
    const active = ordered.includes(preferred) ? preferred : ordered[0]
    return { ...g, tabs: ordered, active }
  })
  tabs = tabs.filter(t => !discard.has(t.id))
  const active = tabs.some(t => t.id === before.active) ? before.active : groups.find(g => g.id === layout.primary)!.active
  groups = groups.map(g => g.tabs.includes(active) ? { ...g, active } : g)
  const activeGroup = groups.find(g => g.tabs.includes(active))!.id
  next = reconcileToolWorkspace({ ...next, tabs, active, editors: { ...editorsOf(next), groups, recent: [activeGroup, ...editorsOf(next).recent.filter(id => id !== activeGroup)] } }, env.catalog)
  return { workspace: next, point, issues: [...new Set(issues)] }
}

