import { expect, it } from 'vitest'
import type { PageContext } from '../../src/plugin-api/ui/contracts'
import type { SidebarCatalog } from '../../src/renderer/src/sidebar-types'
import { applyContainerAction, type ContainerAction } from '../../src/renderer/src/container-actions'
import { describeSidebarContainers } from '../../src/renderer/src/workbench-containers'
import { defaultWorkspace, toolIdOf, validWorkspace, type Workspace } from '../../src/renderer/src/workspace'
import { addContextContainer, placeBoundTool, moveView, readSidebars } from '../../src/renderer/src/sidebar-layout'
import { dockToolCenter, reconcileToolWorkspace } from '../../src/renderer/src/tool-docking'
import { groupOf } from '../../src/renderer/src/editor-layout'

const catalog: SidebarCatalog = {
  containers: [{ id: 'tools', title: '工具', side: 'left' }, { id: 'details', title: '详情', side: 'right' }],
  views: ['draft', 'help', 'details'].map(id => ({ id, title: id, container: id === 'details' ? 'details' : 'tools', placement: { regions: ['left', 'center', 'right'], container: 'tabs' } })),
  contextTools: ['outline', 'bookmarks'].map(id => ({ id, title: id, container: 'tools', order: 0, Component: () => null, context: { requires: ['reading'], detachable: { maxInstances: 2 } } }))
}
function setup() {
  const base = reconcileToolWorkspace(defaultWorkspace(), catalog)
  const w = { ...base, sidebars: addContextContainer(base.sidebars!, 'left') }
  const group = w.sidebars.containers.find(c => c.type === 'context')!.id
  const source: PageContext = { pageId: w.active, type: 'reader', title: '原页面', selection: [], capabilities: { reading: {} }, isAvailable: () => true }
  return { w, group, source }
}
const run = (w: Workspace, action: ContainerAction, context?: PageContext) => {
  const result = applyContainerAction(w, catalog, action, { context, height: 2000 })
  expect(result.blocked).toBeUndefined()
  return result.workspace
}

it('容器快照隔离可见性、选择与来源；隐藏仍保留实例，未知组合和位置不丢失', () => {
  const { w, group, source } = setup()
  w.sidebars.containers.find(c => c.id === group)!.contexts = { reader: { tools: ['missing', 'bookmarks', 'outline'], active: 'bookmarks' } }
  w.sidebars.containers.push({ id: 'missing-group', type: 'tabs', side: 'right', views: ['missing.view'], active: 'missing.view' })
  const before = JSON.stringify(w), snapshot = describeSidebarContainers(w, catalog, [source])
  const smart = snapshot.groups.find(c => c.id === group)!
  expect(smart.context?.items.map(t => t.id)).toEqual(['bookmarks', 'outline'])
  expect(smart.context?.order).toEqual(['missing', 'bookmarks', 'outline'])
  expect(smart.context?.candidates[0]).not.toHaveProperty('Component')
  expect(smart.context?.source).not.toHaveProperty('capabilities')
  expect(snapshot.contextInstances[0].source).toBe(source)
  expect(snapshot.contextInstances[0].tool.Component).toBe(catalog.contextTools[0].Component)
  expect(snapshot.contextInstances.filter(i => i.groupId === group && i.visible).map(i => i.tool.id)).toEqual(['bookmarks'])
  expect(snapshot.groups.find(c => c.id === 'missing-group')).toMatchObject({ present: false, members: ['missing.view'] })
  expect(snapshot.groups[0].members).not.toBe(w.sidebars.containers[0].views)
  expect(smart.context?.order).not.toBe(w.sidebars.containers.find(c => c.id === group)!.contexts!.reader.tools)
  const collapsed = describeSidebarContainers(run(w, { type: 'set-visible', side: 'left', visible: false }), catalog, [source])
  expect(collapsed.groups.find(c => c.id === group)).toMatchObject({ present: true, visible: false })
  expect(collapsed.contextInstances.filter(i => i.groupId === group)).toHaveLength(2)
  expect(collapsed.contextInstances.filter(i => i.groupId === group).every(i => !i.visible)).toBe(true)
  expect(collapsed.contextInstances.map(i => i.key)).toEqual(snapshot.contextInstances.map(i => i.key))
  const multiple = describeSidebarContainers({ ...w, sidebars: addContextContainer(w.sidebars, 'right') }, catalog, [source])
  expect(multiple.contextInstances).toHaveLength(4)
  expect(new Set(multiple.contextInstances.map(i => i.key)).size).toBe(4)
  const unavailable = describeSidebarContainers(w, catalog, [{ ...source, capabilities: {} }]).groups.find(c => c.id === group)!
  expect(unavailable.context?.emptyReason).toBe('当前页面暂无适用工具')
  expect(unavailable.present).toBe(true)
  expect(JSON.stringify(w)).toBe(before)
})

it('关闭混合组只释放其中固定工具；重置侧栏保留中央实例和绑定，重启仍可接续', () => {
  const { w: initial, group, source } = setup()
  let w: Workspace = initial
  const binding = { toolId: 'outline', pageId: source.pageId, pageType: source.type, title: '目录', pageTitle: source.title }
  w = { ...w, sidebars: placeBoundTool(w.sidebars!, binding, 'left', 'tools') }
  const sideId = Object.keys(w.sidebars!.bindings!)[0]
  w = { ...w, sidebars: placeBoundTool(w.sidebars!, { ...binding, toolId: 'bookmarks' }, 'right', 'details') }
  const centerId = Object.keys(w.sidebars!.bindings!).find(id => id !== sideId)!
  w = dockToolCenter(w, centerId, '书签', groupOf(w)!.id)
  const closed = run(w, { type: 'close-group', id: 'tools' })
  expect(closed.sidebars!.bindings?.[sideId]).toBeUndefined()
  expect(closed.sidebars!.bindings?.[centerId]).toEqual(w.sidebars!.bindings![centerId])
  expect(closed.sidebars!.hidden).toEqual(expect.arrayContaining(['draft', 'help']))
  expect(describeSidebarContainers(closed, catalog, [source]).groups.find(c => c.id === 'tools')?.present).toBe(false)
  const reopened = run(closed, { type: 'show-tool', id: 'draft' })
  expect(reopened.sidebars!.hidden).not.toContain('draft')
  expect(reopened.sidebars!.hidden).toContain('help')
  const hiddenSmart = run(w, { type: 'close-group', id: group })
  expect(hiddenSmart.sidebars!.containers.find(c => c.id === group)?.closed).toBe(true)
  expect(run(hiddenSmart, { type: 'show-tool', id: 'outline' }, source).sidebars!.containers.find(c => c.id === group)?.closed).toBe(false)
  const reset = run(w, { type: 'reset-sidebars' })
  expect(reset.tabs).toEqual(w.tabs)
  expect(reset.sidebars!.bindings).toEqual({ [centerId]: w.sidebars!.bindings![centerId] })
  expect(reset.sidebars!.containers.flatMap(c => c.views)).not.toContain(centerId)
  expect(reset.panels).toEqual({ sidebar: true, inspector: true })
  expect(applyContainerAction(reset, catalog, { type: 'show-tool', id: centerId }).focus).toBe(reset.tabs.find(t => toolIdOf(t) === centerId)!.id)
  const restored = reconcileToolWorkspace(validWorkspace(JSON.parse(JSON.stringify(reset)), () => true)!, catalog)
  expect(restored.sidebars!.bindings).toEqual(reset.sidebars!.bindings)
  expect(readSidebars(restored.sidebars)).toEqual(restored.sidebars)
})

it('智能组合动作读取最新偏好并固定请求来源；过期来源、能力或组拒绝且不改状态', () => {
  const { w, group, source } = setup()
  const action = (change: Extract<ContainerAction, { type: 'context' }>['change']): ContainerAction => ({ type: 'context', id: group, source, change })
  w.sidebars.containers.find(c => c.id === group)!.contexts = { reader: { tools: ['missing', 'outline', 'bookmarks'], active: 'outline' }, other: { tools: [] } }
  const reordered = run(w, action({ type: 'reorder', tool: 'bookmarks', direction: -1 }), source)
  const toggled = run(reordered, action({ type: 'toggle', tool: 'outline' }), source)
  expect(toggled.sidebars!.containers.find(c => c.id === group)?.contexts?.reader.tools).toEqual(['missing', 'bookmarks'])
  expect(toggled.sidebars!.containers.find(c => c.id === group)?.contexts?.other).toEqual({ tools: [] })
  expect(w.sidebars!.containers.find(c => c.id === group)?.contexts?.reader.tools).toEqual(['missing', 'outline', 'bookmarks'])
  for (const context of [undefined, { ...source, type: 'other' }, { ...source, isAvailable: () => false }, { ...source, capabilities: {} }]) {
    const result = applyContainerAction(toggled, catalog, action({ type: 'toggle', tool: 'outline' }), { context })
    expect(result.blocked).toBeTruthy(); expect(result.workspace).toBe(toggled)
  }
  const closed = run(toggled, { type: 'close-group', id: group })
  expect(applyContainerAction(closed, catalog, action({ type: 'reset' }), { context: source }).workspace).toBe(closed)
  expect(run(toggled, action({ type: 'reset' }), source).sidebars!.containers.find(c => c.id === group)?.contexts).toEqual({ other: { tools: [] } })
})

it('排序、恢复位置和比例操作在宿主执行；目标已移动或空间不足时不写入', () => {
  const { w, group } = setup()
  const reordered = run(w, { type: 'reorder-tool', id: 'help', group: 'tools', direction: -1 })
  expect(reordered.sidebars!.containers.find(c => c.id === 'tools')?.views).toEqual(['help', 'draft'])
  const moved = { ...reordered, sidebars: moveView(reordered.sidebars!, 'help', 'details') }
  expect(applyContainerAction(moved, catalog, { type: 'reorder-tool', id: 'help', group: 'tools', direction: -1 }).workspace).toBe(moved)
  expect(run(moved, { type: 'reset-tool', id: 'help' }).sidebars!.containers.find(c => c.id === 'tools')?.views).toEqual(['draft', 'help'])
  const sized = run(w, { type: 'resize-groups', first: 'tools', second: group, ratio: .65 })
  expect(sized.sidebars!.weights.tools).toBeCloseTo(1.3)
  const flipped = run(sized, { type: 'reorder-group', id: group, direction: -1 })
  for (const action of [{ type: 'resize-groups', first: 'tools', second: group, ratio: .5 }, { type: 'add-context', side: 'right' }] satisfies ContainerAction[]) {
    const result = applyContainerAction(flipped, catalog, action, { height: 120 })
    expect(result.blocked).toBeTruthy(); expect(result.workspace).toBe(flipped)
  }
})
