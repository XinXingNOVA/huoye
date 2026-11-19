import { expect, it } from 'vitest'
import { pageContext } from '../../src/renderer/src/page-context'
import { contextToolsFor } from '../../src/renderer/src/context-tools'
import type { ContextTool } from '../../src/renderer/src/context-tools'
import type { PageAccess } from '../../src/renderer/src/app/page-access'
import type { TabApi, CollectionFilterCapability } from '../../src/plugin-api/ui/contracts'

it('异步操作固定来源且按 ID 读取新 API，关闭目标后失效；候选及组合只按能力与类型偏好', () => {
  const entries = [{ id: 'a', type: 'collection', params: { title: '同名' } }, { id: 'b', type: 'collection', params: { title: '同名' } }]
  const calls: string[] = []
  const apis: Record<string, TabApi> = { a: { blockFacetQuery: () => ({ ids: ['one'] }), setHasFilters: () => calls.push('has-old'), facetQuery: () => ({ ids: ['one'] }), toggleFilter: () => calls.push('a') }, b: { facetQuery: () => ({ ids: ['two'] }), toggleFilter: () => calls.push('b') } }
  const pages = { entry: (id: string) => entries.find(t => t.id === id), api: (id: string) => apis[id], focus: (id: string) => [id] } as PageAccess
  const a = pageContext(pages, 'a')!, b = pageContext(pages, 'b')!
  expect(a.selection).toEqual(['a']); expect(b.selection).toEqual(['b'])
  const filter = a.capabilities['collection.filter'] as CollectionFilterCapability
  apis.a = { ...apis.a, blockFacetQuery: () => ({ ids: ['latest'] }), setHasFilters: () => calls.push('has-new'), toggleFilter: (_cond, options) => { expect(options).toEqual({ exclusive: true }); calls.push('a-new') } }
  filter.toggleFilter({ op: 'eq', kind: 'file', field: 'ext', value: 'png' }, { exclusive: true })
  expect(calls).toEqual(['a-new'])
  expect(filter.blockFacetQuery?.(['tpl:a'])).toEqual({ ids: ['latest'] })
  filter.setHasFilters?.(['tpl:a'], ['tpl:a']); expect(calls.pop()).toBe('has-new')
  entries.shift(); filter.setHasFilters?.(['tpl:a'], []); expect(filter.blockFacetQuery?.(['tpl:a'])).toEqual({ ids: [] })
  filter.toggleFilter({ op: 'eq', kind: 'file', field: 'ext', value: 'png' }, { exclusive: true })
  expect(a.isAvailable()).toBe(false); expect(calls).toEqual(['a-new']); expect(filter.facetQuery('file', 'ext')).toEqual({ ids: [] })
  const tools: ContextTool[] = ['first', 'second'].map(id => ({ id, title: id, order: 0, context: { requires: ['collection.filter'] }, Component: () => null }))
  const preference = { tools: ['missing', 'second', 'first'], active: 'second' }
  expect(contextToolsFor(tools, b, preference).visible.map(t => t.id)).toEqual(['second', 'first'])
  expect(contextToolsFor(tools, b, preference).active).toBe('second')
  expect(contextToolsFor(tools, { ...b, type: 'reader', capabilities: {} }, preference).visible).toEqual([])
  expect(contextToolsFor(tools, b, preference).active).toBe('second')
  expect(preference.tools[0]).toBe('missing')
})


it('固定工具复用、失效不改绑、上限与布局存档；预设不捕获来源且切换保留真实实例', async () => {
  const { placeBoundTool, removeBoundTool, reconcileSidebars, readSidebars } = await import('../../src/renderer/src/sidebar-layout')
  const { captureWorkbenchLayout, applyWorkbenchLayout } = await import('../../src/renderer/src/workbench-presets')
  const { defaultWorkspace } = await import('../../src/renderer/src/workspace')
  const { boundToolUnavailable, chooseBoundTool } = await import('../../src/renderer/src/context-tools')
  const binding = { toolId: 'test.reader', pageId: 'original', pageType: 'reader', title: '目录', pageTitle: '原页面' }
  const tool: ContextTool = { id: binding.toolId, title: '目录', order: 0, context: { requires: ['test.reading'], detachable: { maxInstances: 1 } }, Component: () => null }
  const source = { pageId: 'original', type: 'reader', title: '原页面', capabilities: { 'test.reading': {} }, selection: [], isAvailable: () => true }
  const base = reconcileSidebars(undefined, [{ id: 'host.navigation', side: 'left' }], [{ id: 'host.navigation', container: 'host.navigation' }])
  const placed = placeBoundTool(base, binding, 'right')
  const [id] = Object.keys(placed.bindings!)
  const moved = placeBoundTool(placed, binding, 'left', 'host.navigation')
  expect(Object.keys(moved.bindings!)).toEqual([id])
  expect(moved.containers.find(c => c.id === 'host.navigation')?.views).toContain(id)
  expect(readSidebars(moved)).toEqual(moved)
  expect(reconcileSidebars(moved, [], [])).toEqual(moved)
  expect(chooseBoundTool(moved, tool, source)).toEqual({ existing: id })
  expect(chooseBoundTool(moved, tool, { ...source, pageId: 'different' }).blocked).toContain('最多')
  // 隐藏、来源类型改变或暂不可用都不释放名额；标题相同不决定身份。
  const hidden = { ...moved, hidden: [...moved.hidden, id] }
  expect(chooseBoundTool(hidden, tool, { ...source, title: '已改名' })).toEqual({ existing: id })
  expect(chooseBoundTool(hidden, tool, { ...source, type: 'other' }).blocked).toContain('最多')
  expect(chooseBoundTool(hidden, tool, { ...source, isAvailable: () => false }).blocked).toContain('来源页面')
  expect(chooseBoundTool(removeBoundTool(hidden, id), tool, { ...source, pageId: 'different' })).toEqual({})
  // 布局恢复不会因插件降低上限丢弃既有固定实例；已有实例仍可定位。
  const extra = placeBoundTool(moved, { ...binding, pageId: 'second' }, 'right')
  const restored = readSidebars(extra)!
  expect(Object.keys(restored.bindings!)).toHaveLength(2)
  expect(chooseBoundTool(restored, tool, source)).toEqual({ existing: id })
  expect(chooseBoundTool(restored, tool, { ...source, pageId: 'third' }).blocked).toContain('最多')
  expect(boundToolUnavailable(binding, tool, undefined)).toBe('目标页面已关闭')
  expect(boundToolUnavailable(binding, tool, { ...source, type: 'other' })).toContain('类型')
  expect(boundToolUnavailable(binding, undefined, source)).toContain('插件')
  expect(boundToolUnavailable(binding, { ...tool, context: { requires: ['test.reading'] } }, source)).toContain('不支持')
  const w = { ...defaultWorkspace(), sidebars: moved }
  const preset = captureWorkbenchLayout(w)
  expect(JSON.stringify(preset)).not.toContain('original')
  expect(preset.sidebars?.bindings).toBeUndefined()
  const applied = applyWorkbenchLayout(w, preset)
  expect(applied.sidebars?.bindings).toEqual(moved.bindings)
  expect(applied.sidebars?.containers.flatMap(c => c.views).filter(v => v === id)).toHaveLength(1)
  const collision = { ...preset, sidebars: { ...preset.sidebars!, containers: [{ id: 'host.navigation', type: 'context' as const, side: 'left' as const, views: [], active: '' }] } }
  const result = applyWorkbenchLayout(w, collision).sidebars!
  expect(new Set(result.containers.map(c => c.id)).size).toBe(result.containers.length)
  expect(result.containers.flatMap(c => c.views)).toContain(id)
  expect(readSidebars(result)?.bindings).toEqual(moved.bindings)
  expect(removeBoundTool(moved, id).bindings).toBeUndefined()
  expect(removeBoundTool(moved, id).containers.flatMap(c => c.views)).not.toContain(id)
})


it('跨区只有一个位置，固定来源独立于位置；重启、预设、关闭保留正确实例规则', async () => {
  const { dockToolCenter, dockToolSide, closeDockTool, reconcileToolWorkspace } = await import('../../src/renderer/src/tool-docking')
  const { defaultWorkspace, toolIdOf, validWorkspace } = await import('../../src/renderer/src/workspace')
  const { editorsOf, groupOf } = await import('../../src/renderer/src/editor-layout')
  const { placeBoundTool } = await import('../../src/renderer/src/sidebar-layout')
  const { captureWorkbenchLayout, applyWorkbenchLayout, BUILTIN_LAYOUTS } = await import('../../src/renderer/src/workbench-presets')
  const catalog: import('../../src/renderer/src/sidebar-types').SidebarCatalog = { containers: [{ id: 'test.tools', title: '测试', side: 'left' }], views: [{ id: 'test.draft', title: '草稿', container: 'test.tools', placement: { regions: ['left', 'center', 'right'] } }], contextTools: [] }
  let w = reconcileToolWorkspace(defaultWorkspace(), catalog)
  const source = w.active
  w = dockToolCenter(w, 'test.draft', '草稿', groupOf(w)!.id, 'right')
  expect(editorsOf(w).groups).toHaveLength(2)
  expect(w.sidebars!.containers.flatMap(c => c.views)).not.toContain('test.draft')
  w = reconcileToolWorkspace(validWorkspace(JSON.parse(JSON.stringify(w)), () => true)!, catalog)
  expect(w.tabs.filter(t => toolIdOf(t) === 'test.draft')).toHaveLength(1)
  expect(w.sidebars!.containers.flatMap(c => c.views)).not.toContain('test.draft')
  w = dockToolSide(w, 'test.draft', 'right')
  expect(w.tabs.some(t => toolIdOf(t))).toBe(false)
  expect(editorsOf(w).groups).toHaveLength(1)
  const binding = { toolId: 'test.reader', title: '目录', pageId: source, pageType: 'collection', pageTitle: '全部' }
  w = { ...w, sidebars: placeBoundTool(w.sidebars!, binding, 'left') }
  const id = Object.keys(w.sidebars!.bindings!)[0]
  w = dockToolCenter(w, id, '目录', groupOf(w)!.id)
  expect(pageContext({ entry: () => w.tabs.find(t => toolIdOf(t) === id), api: () => null } as unknown as PageAccess, w.active)).toBeUndefined()
  const restored = reconcileToolWorkspace(validWorkspace(JSON.parse(JSON.stringify(w)), () => true)!, catalog)
  expect(restored.sidebars?.bindings?.[id]).toEqual(binding)
  const preset = captureWorkbenchLayout(restored)
  expect(JSON.stringify(preset)).not.toContain(source)
  const applied = reconcileToolWorkspace(applyWorkbenchLayout(restored, BUILTIN_LAYOUTS[0].layout), catalog)
  expect(applied.sidebars?.bindings?.[id]).toEqual(binding)
  expect(applied.tabs.filter(t => toolIdOf(t) === id)).toHaveLength(1)
  expect(applied.sidebars?.containers.flatMap(c => c.views)).not.toContain(id)
  expect(closeDockTool(applied, id, catalog).sidebars?.bindings).toBeUndefined()
  w = dockToolCenter(applied, 'test.draft', '草稿', groupOf(applied)!.id)
  const closed = closeDockTool(w, 'test.draft', catalog)
  expect(closed.sidebars?.hidden).toContain('test.draft')
  expect(closed.tabs.some(t => toolIdOf(t) === 'test.draft')).toBe(false)
})
