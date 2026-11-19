import { expect, it } from 'vitest'
import { activeView, availableContainers, closeView, mergeContainers, moveContainer, moveView, readSidebars, reconcileSidebars, resetView, revealView, separateView } from '../../src/renderer/src/sidebar-layout'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { checkToolFeatures, resolveToolDeclarations } from '../../src/shared/tool-placement'
import type { ToolViewContribution } from '../../src/plugin-api/ui/contracts'
import { uiFeaturesSchema } from '../../src/shared/external-plugins'
import { defaultWorkspace, validWorkspace, withStableDocks, panelWidths } from '../../src/renderer/src/workspace'
const containers = [{ id: 'host.navigation', side: 'left' as const }, { id: 'host.inspector', side: 'right' as const }, { id: 'test.tools', side: 'right' as const }]
const views = [{ id: 'host.navigation', container: 'host.navigation' }, { id: 'host.inspector', container: 'host.inspector' }, { id: 'test.draft', container: 'test.tools' }, { id: 'test.status', container: 'test.tools' }]

it('普通组同时显示，加入只切换目标组；移动／拆组不复制内容，关闭后能在原位置重新打开', () => {
  const initial = reconcileSidebars(undefined, containers, views)
  const before = structuredClone(initial)
  expect(readSidebars(initial)).toEqual(initial)
  expect(availableContainers(initial, views)).toHaveLength(3)
  let next = revealView(initial, 'test.draft')
  expect(availableContainers(next, views, 'right')).toHaveLength(2)
  next = moveView(next, 'test.draft', 'host.navigation')
  expect(activeView(next, next.containers[0], views)).toBe('test.draft')
  expect(activeView(next, next.containers.find(c => c.id === 'host.inspector')!, views)).toBe('host.inspector')
  next = separateView(next, 'test.draft', 'left')
  expect(availableContainers(next, views, 'left')).toHaveLength(3)
  expect(readSidebars(next)).toEqual(next)
  const group = next.containers.find(c => c.views.includes('test.draft'))!
  next = closeView(next, 'test.draft')
  expect(availableContainers(next, views, 'left')).toHaveLength(2)
  next = revealView(next, 'test.draft')
  expect(next.containers.find(c => c.views.includes('test.draft'))?.id).toBe(group.id)
  next = moveContainer(next, group.id, 'right', 'host.inspector')
  expect(next.containers.flatMap(c => c.views).sort()).toEqual(views.map(v => v.id).sort())
  expect(moveView(next, 'missing', 'host.navigation')).toBe(next)
  const withClosed = closeView(moveView(next, 'test.status', group.id), 'test.status')
  const merged = mergeContainers(withClosed, group.id, 'host.navigation')
  expect(merged.hidden).toEqual(withClosed.hidden)
  expect(activeView(merged, merged.containers.find(c => c.id === 'host.navigation')!, views)).toBe('test.draft')
  expect(readSidebars(merged)).toEqual(merged)
  expect(initial).toEqual(before)
})

it('v1 可见工具迁为纵向组，后台和折叠工具保持关闭；未知工具、比例和原始备份重启后保留', () => {
  const old = { version: 1, containers: [
    { id: 'host.navigation', side: 'left', views: ['host.navigation', 'test.draft', 'missing.tool'] },
    { id: 'host.inspector', side: 'right', views: ['host.inspector'] },
    { id: 'test.tools', side: 'left', views: ['test.status'] }
  ], selected: { left: 'host.navigation', right: 'host.inspector' }, collapsed: ['missing.tool'], weights: { 'host.navigation': 2, 'test.draft': 3 } }
  const before = structuredClone(old), workspace = validWorkspace({ ...defaultWorkspace(), sidebars: old }, () => true)!
  expect(workspace.sidebarBackup).toEqual(old)
  const layout = workspace.sidebars!
  expect(layout.hidden).toEqual(['missing.tool', 'test.status'])
  expect(availableContainers(layout, views, 'left').flatMap(c => activeView(layout, c, views) ?? [])).toEqual(['host.navigation', 'test.draft'])
  expect(Object.values(layout.weights)).toContain(3)
  expect(layout.containers.flatMap(c => c.views)).toContain('missing.tool')
  const fewer = views.filter(v => !v.id.startsWith('test.'))
  expect(reconcileSidebars(layout, containers, fewer)).toEqual(layout)
  const restored = validWorkspace(JSON.parse(JSON.stringify(workspace)), () => true)!
  expect(restored.sidebars).toEqual(layout)
  expect(restored.sidebarBackup).toEqual(old)
  expect(reconcileSidebars(restored.sidebars, containers, views)).toEqual(layout)
  expect(old).toEqual(before)
  const v3 = { ...layout, version: 3 }
  const next = validWorkspace({ ...workspace, sidebars: v3 }, () => true)!
  expect(next.sidebarBackupV3).toEqual(v3)
  expect(next.sidebars?.version).toBe(4)
})

it('坏存档去重；未知版本拒绝读取；关闭工具不会因协调默认值被重新打开', () => {
  expect(readSidebars({ version: 99, containers: [] })).toBeUndefined()
  const dirty = { version: 2, containers: [null, { id: 'one', type: 'tabs', side: 'left', views: ['a', 'a', null], active: 'gone' }, { id: 'two', type: 'tabs', side: 'right', views: ['a', 'b'], active: 'b' }], selected: { top: 'one' }, weights: { one: NaN, two: -1 }, hidden: ['a', null, 'a'] }
  expect(readSidebars(dirty)).toEqual({ version: 4, containers: [{ id: 'one', type: 'tabs', side: 'left', views: ['a'], active: 'a' }, { id: 'two', type: 'tabs', side: 'right', views: ['b'], active: 'b' }], selected: {}, weights: {}, hidden: ['a'] })
  const layout = closeView(reconcileSidebars(undefined, containers, views), 'host.navigation')
  expect(reconcileSidebars(layout, containers, views)).toEqual(layout)
})

it('退役界面声明明确拒绝；现代工具的身份、上下文与窗口服务继续校验', () => {
  const manifest = [{ id: 'test', title: '测试', description: '布局契约验证' }]
  for (const key of ['sidePanels', 'viewContainers', 'windowWidgets']) {
    expect(() => validateUiContributions([{ id: 'test', [key]: [] }], manifest)).toThrow(`${key} 已退役`)
  }
  const tool = { id: 'test.draft', title: '草稿', order: 1 }
  for (const retired of [{ ...tool, container: 'host.inspector' }, { ...tool, placement: { regions: ['right'] as const, container: 'tabs' } }]) {
    // 模拟已打包的旧 JavaScript；无需重新给公共类型加上退役属性。
    expect(() => validateUiContributions([{ id: 'test', toolViews: [retired as unknown as ToolViewContribution] }], manifest)).toThrow('container 声明已退役')
  }
  const reader = { ...tool, context: { requires: ['test.reader'], detachable: { maxInstances: 0 } } }
  expect(() => validateUiContributions([{ id: 'test', toolViews: [reader] }], manifest)).toThrow('实例上限')
  reader.context.detachable.maxInstances = 2
  expect(() => validateUiContributions([{ id: 'test', toolViews: [reader] }], manifest)).not.toThrow()
  expect(() => validateUiContributions([{ id: 'test', toolViews: [tool, tool] }], manifest)).toThrow('重复')
  expect(() => validateUiContributions([{ id: 'test', toolViews: [{ ...tool, id: 'host.navigation' }] }], manifest)).toThrow('ID')
  expect(() => validateUiContributions([{ id: 'test', windowProviders: [{ id: 'host.x', order: 1 }] }], manifest)).toThrow('ID')
  // 登记元信息仍可读，避免因一个旧包损坏整份安装／仓库登记；执行门槛另行拒绝。
  const retiredFeatures = ['view-containers-v1', 'tool-docking-v1']
  expect(uiFeaturesSchema.parse(retiredFeatures)).toEqual(retiredFeatures)
  for (const feature of retiredFeatures) expect(() => checkToolFeatures([], [feature])).toThrow('已退役')
})

it('智能组保留空状态和按类型偏好；不接纳普通成员，旧 v2 导航只拆分一次并保留备份', () => {
  const old = { version: 2, containers: [{ id: 'host.navigation', type: 'tabs', side: 'right', views: ['host.navigation'], active: 'host.navigation' }], selected: {}, hidden: [], weights: { 'host.navigation': 2 } }
  const w = validWorkspace({ ...defaultWorkspace(), sidebars: old }, () => true)!
  expect(w.sidebarBackupV2).toEqual(old)
  const layout = w.sidebars!, group = layout.containers.find(c => c.type === 'context')!
  expect(group.side).toBe('right')
  group.contexts = { collection: { tools: ['missing.tool', 'host.filters'], active: 'missing.tool' } }
  group.closed = true
  expect(readSidebars(layout)).toEqual(layout)
  expect(moveView(layout, 'host.navigation', group.id)).toBe(layout)
  expect(mergeContainers(layout, group.id, 'host.navigation')).toBe(layout)
  const restored = reconcileSidebars(layout, containers, views)
  expect(restored.containers.find(c => c.id === group.id)).toEqual(group)
})


it('内容不指定容器也能装配；显式默认组合、区域与能力门槛在声明边界校验', () => {
  const Component = () => null
  const draft: ToolViewContribution = { id: 'test.draft', title: '草稿', order: 1, Component }
  const status: ToolViewContribution = { id: 'test.status', title: '说明', order: 2, Component, placement: { regions: ['left', 'right'], default: { region: 'left', group: 'test.shared' } } }
  const reader: ToolViewContribution = { id: 'test.reader', title: '目录', order: 3, Component, context: { requires: ['test.document'] } }
  const tools = [draft, status, { ...status, id: 'test.second' }, reader]
  expect(() => validateUiContributions([{ id: 'test', toolViews: tools }], [{ id: 'test', title: '测试', description: '' }])).not.toThrow()
  const resolved = resolveToolDeclarations('test', tools)
  expect(resolved.groups.map(g => [g.id, g.side])).toEqual([['default:test.draft', 'right'], ['test.shared', 'left']])
  expect(resolved.views.map(v => v.container)).toEqual(['default:test.draft', 'test.shared', 'test.shared', 'host.context'])
  expect(resolved.views[0].Component).toBe(Component)
  expect(resolved.views[3].context).toBe(reader.context)
  expect(resolved.groups.some(g => g.id === 'host.context')).toBe(false)
  expect(draft).not.toHaveProperty('container')
  expect(resolveToolDeclarations('test', [{ ...draft, placement: { regions: ['left'] } }]).groups[0].side).toBe('left')
  const invalid: ToolViewContribution[] = [
    { ...draft, placement: { regions: ['center'] } },
    { ...draft, placement: { regions: ['right'], default: { region: 'left' } } },
    { ...draft, placement: { regions: ['right'], default: { region: 'right', group: 'other.group' } } },
    { ...draft, placement: { regions: ['right'], default: { region: 'right', group: 'toString' } } },
    { ...draft, placement: { regions: ['right'], default: { region: 'right', group: 'host.navigation' } } },
    { ...reader, placement: { regions: ['right'], default: { region: 'right' } } }
  ]
  for (const tool of invalid) expect(() => resolveToolDeclarations('test', [tool])).toThrow()
  expect(() => resolveToolDeclarations('test', [status, { ...status, id: 'test.second', placement: { regions: ['right'], default: { region: 'right', group: 'test.shared' } } }])).toThrow('不一致')
  expect(uiFeaturesSchema.parse(['tool-placement-v1'])).toEqual(['tool-placement-v1'])
  expect(() => checkToolFeatures(tools, ['tool-placement-v1'])).not.toThrow()
  expect(() => checkToolFeatures(tools)).toThrow('tool-placement-v1')
})

it('新声明接续旧位置与关闭状态；默认变化仅影响初次装配或显式恢复，不重排保存的组', () => {
  const Component = () => null
  let layout = revealView(reconcileSidebars(undefined, containers, views), 'test.draft')
  layout = closeView(moveContainer(layout, 'test.tools', 'left'), 'test.draft')
  layout.weights['test.tools'] = 2.5
  layout.containers.find(g => g.id === 'test.tools')!.views.push('missing.tool')
  const before = structuredClone(layout)
  const draft: ToolViewContribution = { id: 'test.draft', title: '草稿', order: 1, Component }
  const status: ToolViewContribution = { id: 'test.status', title: '说明', order: 2, Component, placement: { regions: ['right'], default: { region: 'right', group: 'test.tools' } } }
  const resolved = resolveToolDeclarations('test', [draft, status])
  const defaults = [...containers.filter(g => g.id !== 'test.tools'), ...resolved.groups]
  const available = [...views.filter(v => v.id.startsWith('host.')), ...resolved.views]
  const restored = reconcileSidebars(JSON.parse(JSON.stringify(layout)), defaults, available)
  expect(restored).toEqual(before)
  const reopened = revealView(restored, draft.id)
  expect(reopened.containers.find(g => g.views.includes(draft.id))).toMatchObject({ id: 'test.tools', side: 'left' })
  const reset = resetView(reopened, draft.id, defaults, available)
  expect(reset.containers.find(g => g.views.includes(draft.id))).toMatchObject({ id: 'default:test.draft', side: 'right' })
  expect(reset.containers.find(g => g.id === 'test.tools')?.views).toEqual(['test.status', 'missing.tool'])
  expect(reset.weights['test.tools']).toBe(2.5)
  expect(readSidebars(reset)).toEqual(reset)
  const fresh = reconcileSidebars(undefined, defaults, available)
  expect(fresh.containers.find(g => g.views.includes(draft.id))?.id).toBe('default:test.draft')
  expect(fresh.hidden).toContain(draft.id) // 新工具不会挤开当前右栏。
  expect(layout).toEqual(before)
})

it('旧侧栏只接续一次，中央标签变化不夺取面板选择；未知插件选择保留', () => {
  const original = { ...defaultWorkspace(), docks: { left: 'missing.navigation' } }
  const migrated = withStableDocks(original, { left: 'example.library', right: 'example.lyrics' })
  expect(migrated.docks).toEqual({ left: 'missing.navigation', right: 'example.lyrics' })
  expect(withStableDocks(migrated, { right: 'host.inspector' }).docks).toEqual(migrated.docks)
  expect(withStableDocks(defaultWorkspace(), { left: 'example.library' }).docks?.left).toBe('host.navigation')
  expect(withStableDocks({ ...defaultWorkspace(), docks: undefined }).docks).toEqual({ left: 'host.navigation', right: 'host.inspector' })
})

it('侧栏宽度恢复会校验坏值，窄窗口为主区域留出空间，不覆盖用户偏好', () => {
  const sizes = { sidebar: 360, inspector: 480 }
  const narrow = panelWidths(sizes, 960)
  expect(narrow.sidebar + narrow.inspector).toBe(960 - 48 - 320)
  expect(panelWidths(sizes, 1440)).toEqual(sizes)
  expect(panelWidths({ sidebar: NaN, inspector: Infinity }, 1440)).toEqual({ sidebar: 220, inspector: 300 })
  expect(validWorkspace({ ...defaultWorkspace(), panelSizes: { sidebar: 'bad', inspector: 333 } }, () => true)?.panelSizes).toEqual({ inspector: 333 })
})
