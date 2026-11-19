import { expect, it } from 'vitest'
import { hitSidebarDrop, hitEditorDrop, type GroupGeometry } from '../../src/renderer/src/workbench-hit-test'
import type { PageContext, TabType } from '../../src/plugin-api/ui/contracts'
import type { SidebarCatalog } from '../../src/renderer/src/sidebar-types'
import { describePage, describeTab, describeTools, contentPlacementReason } from '../../src/renderer/src/workbench-content'
import { placeToolContent, resolveToolPlacement, type DockSource, type DockTarget } from '../../src/renderer/src/workbench-placement'
import { reconcileToolWorkspace, closeDockTool } from '../../src/renderer/src/tool-docking'
import { addContextContainer } from '../../src/renderer/src/sidebar-layout'
import { groupOf } from '../../src/renderer/src/editor-layout'
import { defaultWorkspace, toolIdOf } from '../../src/renderer/src/workspace'

const catalog: SidebarCatalog = {
  containers: [{ id: 'tools', title: '工具', side: 'left' }, { id: 'details', title: '详情', side: 'right' }],
  views: [
    { id: 'draft', title: '草稿', container: 'tools', placement: { regions: ['left', 'center', 'right'] }, Component: () => null },
    { id: 'legacy', title: '仅侧栏工具', container: 'details' }
  ],
  contextTools: [{ id: 'outline', title: '目录', order: 0, Component: () => null,
    placement: { regions: ['left', 'center', 'right'] }, context: { requires: ['reading'], detachable: { maxInstances: 1 } } }]
}
const setup = () => {
  const base = reconcileToolWorkspace(defaultWorkspace(), catalog)
  const w = { ...base, sidebars: addContextContainer(base.sidebars!, 'left') }
  const context: PageContext = { pageId: w.active, type: 'reader', title: '原文', capabilities: { reading: {} }, selection: [], isAvailable: () => true }
  const smart = w.sidebars!.containers.find(c => c.type === 'context')!
  const source: DockSource = { type: 'context-tool', id: 'outline', pageId: w.active, containerId: smart.id }
  return { w, context, source }
}
const space = { sideHeight: 1200, editorRect: { x: 0, y: 0, width: 1200, height: 900 } }

it('描述适配保留原组件与默认位置；缺失工具仍可移出中央，页面不获得侧栏能力', () => {
  const { w } = setup(), entry = w.tabs[0]
  const definition: TabType = { id: entry.type, Title: () => null, Component: () => null }
  const page = describePage(entry, definition), tools = describeTools(w, catalog)
  expect(describeTab(entry, tools, definition)).toEqual(page)
  expect(page.definition?.Title).toBe(definition.Title)
  expect(contentPlacementReason(page, 'left')).toContain('不支持')
  expect(tools[0].Component).toBe(catalog.views[0].Component)
  expect(tools[0].defaultPlacement).toEqual({ region: 'left', group: 'tools' })
  expect(contentPlacementReason(tools[1], 'center')).toContain('不支持')
  const moved = placeToolContent(w, catalog, { type: 'view', id: 'draft' }, { region: 'center' }, undefined, space)
  const absent = { ...catalog, views: catalog.views.filter(v => v.id !== 'draft') }
  const missing = describeTab(moved.tabs.find(t => toolIdOf(t) === 'draft')!, describeTools(moved, absent), undefined)
  expect(missing).toMatchObject({ kind: 'tool', id: 'draft', available: false })
  expect(contentPlacementReason(missing, 'center')).toContain('不支持')
  expect(contentPlacementReason(missing, 'right')).toBeUndefined()
  const rescued = placeToolContent(moved, absent, { type: 'view', id: 'draft' }, { region: 'right' }, undefined, space)
  expect(rescued.tabs.some(t => toolIdOf(t) === 'draft')).toBe(false)
  expect(rescued.sidebars?.containers.some(c => c.side === 'right' && c.views.includes('draft'))).toBe(true)
})

it('预览与提交使用同一拒绝规则，落点或来源失效不创建绑定、不改布局', () => {
  const { w, source, context } = setup(), snapshot = JSON.stringify(w)
  const cases: { target: DockTarget; context?: PageContext; space?: typeof space; reason: string }[] = [
    { target: { region: 'center', group: 'closed' }, context, reason: '已关闭' },
    { target: { region: 'right', group: 'closed' }, context, reason: '已关闭' },
    { target: { region: 'left', group: source.type === 'context-tool' ? source.containerId : '' }, context, reason: '智能组' },
    { target: { region: 'center' }, reason: '来源页面' },
    { target: { region: 'center' }, context: { ...context, capabilities: {} }, reason: '来源页面' },
    { target: { region: 'center' }, context: { ...context, pageId: 'different' }, reason: '来源页面' },
    { target: { region: 'right' }, context, space: { ...space, sideHeight: 120 }, reason: '空间不足' },
    { target: { region: 'center', edge: 'right' }, context, space: { ...space, editorRect: { x: 0, y: 0, width: 200, height: 200 } }, reason: '空间不足' }
  ]
  for (const c of cases) {
    expect(resolveToolPlacement(w, catalog, source, c.target, c.context, c.space ?? space).blocked).toContain(c.reason)
    expect(placeToolContent(w, catalog, source, c.target, c.context, c.space ?? space)).toBe(w)
  }
  expect(JSON.stringify(w)).toBe(snapshot)
})

it('智能入口固定一次后可跨区复用，加入与独立落点不同；关闭仍遵守普通/固定工具原规则', () => {
  const { w, source, context } = setup()
  let next = placeToolContent(w, catalog, source, { region: 'center', edge: 'right' }, context, space)
  const [id] = Object.keys(next.sidebars!.bindings!)
  expect(next.sidebars!.containers.find(c => c.id === (source as Extract<DockSource, { type: 'context-tool' }>).containerId)).toEqual(w.sidebars!.containers.find(c => c.type === 'context'))
  expect(next.tabs.filter(t => toolIdOf(t) === id)).toHaveLength(1)
  const selfSplit: DockTarget = { region: 'center', group: groupOf(next)!.id, edge: 'right' }
  expect(resolveToolPlacement(next, catalog, { type: 'view', id }, selfSplit, undefined, space).blocked).toContain('无需拆分')
  expect(placeToolContent(next, catalog, { type: 'view', id }, selfSplit, undefined, space)).toBe(next)
  expect(resolveToolPlacement(next, catalog, source, selfSplit, context, space).blocked).toContain('无需拆分')
  expect(resolveToolPlacement(next, catalog, { ...source, pageId: 'other' } as DockSource, { region: 'right' }, { ...context, pageId: 'other' }, space).blocked).toContain('最多')
  next = placeToolContent(next, catalog, source, { region: 'right', group: 'details', before: 'legacy' }, context, space)
  expect(Object.keys(next.sidebars!.bindings!)).toEqual([id])
  expect(next.sidebars!.containers.find(c => c.id === 'details')!.views).toEqual([id, 'legacy'])
  expect(next.tabs.some(t => toolIdOf(t) === id)).toBe(false)
  next = placeToolContent(next, catalog, { type: 'view', id }, { region: 'right', group: 'details', edge: 'bottom' }, undefined, space)
  const right = next.sidebars!.containers.filter(c => c.side === 'right')
  expect(right.map(c => c.views)).toEqual([['legacy'], [id]])
  expect(next.sidebars!.bindings![id].pageId).toBe(context.pageId)
  expect(closeDockTool(next, id, catalog).sidebars?.bindings).toBeUndefined()
  next = placeToolContent(next, catalog, { type: 'view', id: 'draft' }, { region: 'center', group: groupOf(next)!.id }, undefined, space)
  const closed = closeDockTool(next, 'draft', catalog)
  expect(closed.sidebars!.containers.find(c => c.views.includes('draft'))?.side).toBe('left')
  expect(closed.sidebars!.hidden).toContain('draft')
})

it('拖放预览不占名额，提交时复核最新数量与来源类型；拒绝不改变已有实例', () => {
  const { w, source, context } = setup(), target: DockTarget = { region: 'right' }
  expect(resolveToolPlacement(w, catalog, source, target, context, space).blocked).toBeUndefined()
  expect(w.sidebars!.bindings).toBeUndefined()
  // 预览后另一页面先完成固定；旧预览不能绕过窗口配额。
  const other = { ...context, pageId: 'other' }
  const occupied = placeToolContent(w, catalog, { ...source, pageId: other.pageId } as DockSource, target, other, space)
  expect(placeToolContent(occupied, catalog, source, target, context, space)).toBe(occupied)
  // 同一来源页 ID 换了内容类型，也不能误复用旧绑定。
  const fixed = placeToolContent(w, catalog, source, target, context, space)
  expect(placeToolContent(fixed, catalog, source, target, { ...context, type: 'different' }, space)).toBe(fixed)
  // 同一份固定工具反复拖出仅移动，关闭后才释放名额。
  const [id] = Object.keys(occupied.sidebars!.bindings!)
  const closed = closeDockTool(occupied, id, catalog)
  const accepted = placeToolContent(closed, catalog, source, target, context, space)
  expect(Object.values(accepted.sidebars!.bindings!).map(b => b.pageId)).toEqual([context.pageId])
})

// 外壳可改样式和包装层，命中只取屏幕坐标；分割间隙不能误落到相邻组。
it('命中区分标题插入、正文加入和边缘拆分；空侧栏可接收，中央间隙无落点', () => {
  const bounds = { x: 50, y: 80, width: 300, height: 600 }
  const group: GroupGeometry = { id: 'one', rect: bounds, header: { ...bounds, height: 40 },
    items: [{ id: 'first', rect: { x: 80, y: 80, width: 90, height: 40 } }, { id: 'second', rect: { x: 170, y: 80, width: 90, height: 40 } }] }
  expect(hitSidebarDrop(bounds, [group], { x: 180, y: 100 }).target).toEqual({ group: 'one', beforeView: 'second' })
  expect(hitSidebarDrop(bounds, [group], { x: 180, y: 400 }).target).toEqual({ group: 'one', edge: undefined })
  const lower = hitSidebarDrop(bounds, [group], { x: 180, y: 620 })
  expect(lower.target).toEqual({ group: 'one', edge: 'bottom' })
  expect(lower.rect).toEqual({ x: 4, y: 304, width: 292, height: 292 })
  expect(hitSidebarDrop(bounds, [{ ...group, context: true }], { x: 180, y: 400 }).target.edge).toBe('bottom')
  expect(hitSidebarDrop(bounds, [], { x: 180, y: 400 }).target).toEqual({})
  const neighbor = { ...group, id: 'two', rect: { ...bounds, x: 355 }, header: { ...group.header, x: 355 }, items: [] }
  expect(hitEditorDrop([group, neighbor], { x: 352, y: 400 })).toBeUndefined()
  expect(hitEditorDrop([group], { x: 0, y: 0 }, 'one')).toEqual({ group: 'one', before: 'first' })
  expect(hitEditorDrop([group], { x: 55, y: 100 })).toEqual({ group: 'one', before: 'first' })
  expect(hitEditorDrop([group], { x: 55, y: 400 })).toEqual({ group: 'one', edge: 'left' })
})
