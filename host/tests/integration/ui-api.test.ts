import { sameValue, uniqueCollectionFilters, toggleCollectionFilter } from '../../src/renderer/src/collection-query'
import type { Cond } from '../../src/shared/query'
import { layoutConfigurationSchema, layoutOptions, layoutZoom, layoutRecord, readBrowsingDefault, saveBrowsingDefault, restoreLayoutStates } from '../../src/shared/browsing-layout'
import { collectionFacetQuery, collectionBlockFacetQuery, replaceHasFilters, collectionQuery, scopeCollectionQuery, scopeCollectionResult } from '../../src/shared/collection'
import { pageInputReason, pageInputsSchema } from '../../src/shared/page-inputs'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkUiBoundaries } from '../../scripts/checks/ui-boundaries'
import { EntityCache } from '../../src/renderer/src/entity-store'
import { ENTITY_DRAG_TYPE, startEntityDrag } from '../../src/renderer/src/entity-drag'
import { computeMasonry } from '../../src/plugin-api/ui/layout'
import type { EntityView } from '../../src/shared/blocks'
import type { CoreClient } from '../../src/plugin-api/core'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach((f) => f()); vi.useRealTimers() })
const view = (id: string, label = id): EntityView => ({ id, createdAt: 0, deletedAt: null, blocks: { note: { data: { text: label }, seq: 1, ver: 1 } }, failures: {} })
function cacheHarness() {
  vi.useFakeTimers()
  let changed: (p: { ids: string[] }) => void = () => {}
  const off = vi.fn()
  const get = vi.fn<CoreClient['get']>().mockResolvedValue([])
  const core = { get, on: ((_event, fn) => { changed = fn as typeof changed; return off }) as CoreClient['on'] }
  const cache = new EntityCache(core)
  cleanup.push(() => cache.dispose())
  return { cache, get, off, change: (...ids: string[]) => changed({ ids }), flush: () => vi.advanceTimersByTimeAsync(20) }
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

describe('公共素材订阅的宿主实现', () => {
  it('合并订阅读取，快照稳定，卸载前取消未发出的请求', async () => {
    const { cache, get, flush } = cacheHarness()
    get.mockResolvedValue([view('a'), view('b')])
    expect(cache.getSnapshot('a')).toBe(cache.getSnapshot('a'))
    const a = cache.subscribe('a', vi.fn())
    cache.subscribe('a', vi.fn())
    cache.subscribe('b', vi.fn())
    cache.subscribe('cancelled', vi.fn())()
    await flush()
    expect(get).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
    const ready = cache.getSnapshot('a')
    expect(ready.status).toBe('ready')
    expect(cache.getSnapshot('a')).toBe(ready)
    a()
  })
  it('旧读取不能覆盖事件后启动的新读取', async () => {
    const { cache, get, flush, change } = cacheHarness()
    const older = deferred<EntityView[]>(), newer = deferred<EntityView[]>()
    get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    cache.subscribe('a', vi.fn())
    await flush()
    change('a'); await flush()
    newer.resolve([view('a', 'new')]); await Promise.resolve()
    const fresh = cache.getSnapshot('a')
    older.resolve([view('a', 'old')]); await Promise.resolve()
    expect(cache.getSnapshot('a')).toBe(fresh)
    expect(cache.get('a')?.blocks.note.data.text).toBe('new')
  })
  it('缺失与读取失败不同，刷新失败保留旧内容，事件能恢复', async () => {
    const { cache, get, flush, change } = cacheHarness()
    cache.subscribe('a', vi.fn())
    await flush()
    expect(cache.getSnapshot('a').status).toBe('missing')
    get.mockResolvedValueOnce([view('a')]); change('a'); await flush()
    get.mockRejectedValueOnce(new Error('offline')); change('a'); await flush()
    expect(cache.getSnapshot('a')).toMatchObject({ status: 'error', error: 'offline', view: { id: 'a' } })
    get.mockResolvedValueOnce([view('a', 'recovered')]); change('a'); await flush()
    expect(cache.getSnapshot('a').status).toBe('ready')
    expect(cache.get('a')?.blocks.note.data.text).toBe('recovered')
  })
  it('卸载后重订阅发起新读取，即使没有变化事件也拒绝旧响应', async () => {
    const { cache, get, flush } = cacheHarness()
    const older = deferred<EntityView[]>(), newer = deferred<EntityView[]>()
    get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const unsubscribe = cache.subscribe('a', vi.fn()); await flush(); unsubscribe()
    cache.subscribe('a', vi.fn()); unsubscribe(); await flush()
    newer.resolve([view('a', 'new')]); await Promise.resolve()
    older.resolve([view('a', 'old')]); await Promise.resolve()
    expect(cache.get('a')?.blocks.note.data.text).toBe('new')
  })
  it('重订阅失败项可重试；销毁移除监听并忽略在途结果', async () => {
    const { cache, get, flush, off } = cacheHarness()
    get.mockRejectedValueOnce(new Error('offline'))
    const unsubscribe = cache.subscribe('a', vi.fn()); await flush(); unsubscribe()
    const pending = deferred<EntityView[]>()
    get.mockReturnValueOnce(pending.promise)
    const listener = vi.fn()
    cache.subscribe('a', listener); await flush()
    cache.dispose()
    cache.dispose()
    pending.resolve([view('a')]); await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    expect(cache.get('a')).toBeUndefined()
    expect(off).toHaveBeenCalledTimes(1)
  })
})

describe('拖拽与布局公共契约', () => {
  const gesture = () => ({ preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } })
  it('全部已加载且可导出时同步交出多份文件；不额外异步查询', () => {
    const e = gesture(), native = vi.fn()
    startEntityDrag(e, ['a', 'b'], view, (v) => ({ file: `/library/${v.id}`, icon: 'icon' }), native)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(native).toHaveBeenCalledExactlyOnceWith(['/library/a', '/library/b'], 'icon')
    expect(e.dataTransfer.setData).not.toHaveBeenCalled()
  })
  it('混合素材和未加载的选择都保留完整 ID；空选择不发原生拖动', () => {
    const e = gesture(), native = vi.fn()
    startEntityDrag(e, ['a', 'b'], (id) => id === 'a' ? view(id) : undefined, (v) => ({ file: v.id }), native)
    expect(e.dataTransfer.setData).toHaveBeenCalledWith(ENTITY_DRAG_TYPE, '["a","b"]')
    expect(e.dataTransfer.effectAllowed).toBe('copyMove')
    startEntityDrag(e, [], view, () => undefined, native)
    expect(native).not.toHaveBeenCalled()
  })
  it('标题区高度由调用者指定；旧卡片高度和坐标保持，纯封面布局不被固定标题占位', () => {
    const standard = computeMasonry([1, 2, 1], 410, 200, 10, 28)
    const covers = computeMasonry([1, 2, 1], 410, 200, 10, 0)
    expect([...standard.h]).toEqual([228, 128, 228])
    expect([...standard.y]).toEqual([0, 0, 138])
    expect([...covers.h]).toEqual([200, 100, 200])
    expect([...covers.y]).toEqual([0, 0, 110])
  })
})

function boundaryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rm-ui-boundary-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const file = (name: string, text: string) => { const p = join(root, 'src', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p }
  file('renderer/src/entity-cache.ts', 'export const CacheContext = {}')
  file('plugin-api/ui/internal/runtime.ts', 'export const context = {}')
  file('plugin-api/ui/data.ts', "import {context} from './internal/runtime'\nexport const useEntity = () => context")
  return { root, file }
}

describe('插件 UI 边界检查', () => {
  it('公共入口可使用宿主注入点，插件只能使用公开模块', () => {
    const { root, file } = boundaryFixture()
    const entry = file('plugins/new/ui.ts', "export {useEntity} from '../../plugin-api/ui/data'")
    expect(() => checkUiBoundaries(root, [entry])).not.toThrow()
    file('plugins/new/ui.ts', "import {context} from '../../plugin-api/ui/internal/runtime'")
    expect(() => checkUiBoundaries(root, [entry])).toThrow(/内部注入/)
  })
  it.each([
    "import {CacheContext} from '../../renderer/src/entity-cache'",
    "export {CacheContext} from '../../renderer/src/entity-cache'",
    "import type {CacheContext} from '../../renderer/src/entity-cache'",
    "type Cache = import('../../renderer/src/entity-cache').CacheContext",
    "const cache = import('../../renderer/src/entity-cache')"
  ])('宿主私有路径的各种引用都会被阻止：%s', (code) => {
    const { root, file } = boundaryFixture()
    const entry = file('plugins/new/ui.ts', "import './helper'")
    file('plugins/new/helper.ts', code)
    expect(() => checkUiBoundaries(root, [entry])).toThrow(/plugins\/new\/ui.ts.*helper.ts.*entity-cache.ts/)
  })
  it.each(['window.bridge.contextMenu([])', "window['bridge'].contextMenu([])", 'const {bridge} = window'])('原生通道必须经 UiHost：%s', (code) => {
    const { root, file } = boundaryFixture()
    expect(() => checkUiBoundaries(root, [file('plugins/new/ui.ts', code)])).toThrow(/bridge/)
  })
  it('公共 API 不能运行时导入装配清单，但允许插件公开契约的类型引用', () => {
    const { root, file } = boundaryFixture()
    file('plugins/generated/ui.ts', 'export const entries = []')
    file('plugin-api/ui/data.ts', "import {entries} from '../../plugins/generated/ui'")
    const entry = file('plugins/new/ui.ts', "import '../../plugin-api/ui/data'")
    expect(() => checkUiBoundaries(root, [entry])).toThrow(/反向加载/)
    file('plugin-api/ui/data.ts', "import '../../shared/helper'")
    file('shared/helper.ts', "import '../plugins/generated/ui'")
    expect(() => checkUiBoundaries(root, [entry])).toThrow(/反向加载/)
    file('plugin-api/ui/data.ts', "import type {entries} from '../../plugins/generated/ui'")
    expect(() => checkUiBoundaries(root, [entry])).not.toThrow()
  })
})

it('动态集合范围与完整查询相交；空范围不退回全库，缩小时过滤旧结果并保持宽高比对齐', () => {
  const params = { title: '动态', query: { ids: ['a', 'b'], has: ['file'] }, layout: 'masonry' }
  const query = collectionQuery(params, { filters: [{ kind: 'file', field: 'ext', op: 'in', values: ['png', 'jpg'] }], search: '图', criteria: { lacks: ['note'] } })
  expect(scopeCollectionQuery(query, ['b', 'c', 'b'])).toMatchObject({ ids: ['b'], has: ['file'], lacks: ['note'], where: query.where, search: query.search })
  expect(scopeCollectionQuery(query, []).ids).toEqual([])
  expect(scopeCollectionQuery(query)).toBe(query)
  const result = { ids: ['a', 'b', 'c'], aspects: [1, 2, 3] }
  expect(scopeCollectionResult(result, ['b'])).toEqual({ ids: ['b'], aspects: [2] })
  expect(scopeCollectionResult(result, [])).toEqual({ ids: [], aspects: [] })
  expect(params.query.ids).toEqual(['a', 'b'])
})

it('分面只排除同字段临时条件，保留基础标签、搜索、其他条件和动态范围', () => {
  const base = { op: 'eq' as const, kind: 'tags', field: 'values', value: '项目A' }
  const format = { op: 'eq' as const, kind: 'file', field: 'ext', value: 'png' }
  const params = { title: '项目图片', query: { has: ['image'], ids: ['a', 'b'], where: [base], text: '原文' } }
  const state = { filters: [base, { ...base, value: '红色' }, format], criteria: { lacks: ['note'], sort: 'created' as const }, search: '插画' }
  const query = collectionFacetQuery(params, state, 'tags', 'values', ['b', 'c'])
  expect(query).toMatchObject({ where: [base, format], has: ['image'], lacks: ['note'], ids: ['b'], text: '原文', search: [{ text: '插画' }] })
  expect(query.sort).toBeUndefined()
  expect(collectionFacetQuery(params, state, 'tags', 'values', []).ids).toEqual([])
  expect(collectionFacetQuery(params, state, 'file', 'ext').where).toEqual([base, base, { ...base, value: '红色' }])
  expect(state.filters).toHaveLength(3)
})

it('页面输入声明保留未声明行为，拒绝策略使用统一原因；动态与旧静态角标可共存', () => {
  expect(pageInputReason(undefined, 'receive')).toBeUndefined()
  expect(pageInputReason({ receive: false, reason: '请到普通视图' }, 'receive')).toBe('请到普通视图')
  expect(pageInputReason({ receive: false }, 'create')).toBeUndefined()
  expect(pageInputsSchema.safeParse({ receive: 'false' }).success).toBe(false)
  const manifest = [{ id: 'demo', title: '示例', description: '' }]
  const badge = { id: 'demo.live', order: 1, Component: () => null }
  const validate = (badges: unknown[], inputs: unknown = { receive: false, create: false }) => validateUiContributions([{ id: 'demo', badges: badges as typeof badge[], tabTypes: [{ id: 'demo.page', inputs }] }], manifest)
  expect(() => validate([{ order: 0, get: () => undefined }, badge])).not.toThrow()
  expect(() => validate([badge, badge])).toThrow('重复')
  expect(() => validate([{ ...badge, id: 'other.live' }])).toThrow('角标 ID')
  expect(() => validate([{ ...badge, get: () => undefined }])).toThrow('get 或 Component')
  expect(() => validate([badge], { create: 'false' })).toThrow('页面输入规则')
})

it('文件编辑界面贡献限定插件命名空间，启停走统一贡献装配', () => {
  const manifest = [{ id: 'demo', title: '示例', description: '' }]
  const ui = { id: 'demo.editor', priority: 100, open: async () => {} }
  const check = (value: typeof ui) => validateUiContributions([{ id: 'demo', fileEditingUis: [value] }], manifest)
  expect(() => check(ui)).not.toThrow()
  expect(() => check({ ...ui, id: 'another.editor' })).toThrow('文件编辑界面声明')
  expect(() => check({ ...ui, priority: NaN })).toThrow('文件编辑界面声明')
})


describe('浏览布局配置与本机状态边界', () => {
  it('尺寸声明按布局校验；默认选项隔离，私有状态拒绝不可保存值', () => {
    expect(layoutConfigurationSchema.safeParse({ title: '表格', size: false }).success).toBe(true)
    expect(layoutConfigurationSchema.safeParse({ title: '错误', size: { label: '列宽', min: 300, max: 100, default: 220 } }).success).toBe(false)
    const config = { defaultOptions: { columns: ['title'], mode: 'compact' }, size: { label: '行高', min: 24, max: 60, step: 4, default: 32 } }
    expect(layoutZoom(config, 220)).toBe(60)
    expect(layoutZoom(config, NaN)).toBe(32)
    const options = layoutOptions(config, { mode: 'wide' }); (options.columns as string[]).push('size')
    expect(config.defaultOptions.columns).toEqual(['title'])
    expect(options.mode).toBe('wide')
    expect(() => layoutRecord({ handler() {} })).toThrow()
    expect(() => layoutRecord({ row: Infinity })).toThrow()
    expect(() => layoutRecord({ text: 'a'.repeat(65537) })).toThrow()
  })
  it('按仓库隔离默认值，缺席布局保持偏好，损坏配置回退且写入失败不假报成功', () => {
    const data = new Map<string, string>(), storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
    saveBrowsingDefault(storage, 'a', { layout: 'missing.layout', options: { groupBy: 'stage' }, zoom: 280 })
    const captured = readBrowsingDefault(storage, 'a')
    expect(captured.layout).toBe('missing.layout')
    expect(readBrowsingDefault(storage, 'b').layout).toBe('masonry')
    saveBrowsingDefault(storage, 'a', { layout: 'table', options: {} })
    expect(captured.options).toEqual({ groupBy: 'stage' })
    expect(captured.layout).toBe('missing.layout')
    expect(() => saveBrowsingDefault({ ...storage, setItem: () => { throw new Error('full') } }, 'a', { layout: 'x', options: {} })).toThrow('full')
    expect(readBrowsingDefault(storage, 'a').layout).toBe('table')
    saveBrowsingDefault(storage, 'a'); expect(readBrowsingDefault(storage, 'a').layout).toBe('masonry')
    expect(readBrowsingDefault({ getItem: () => '{broken' }, 'a').layout).toBe('masonry')
  })
  it('旧锚点只接续原布局，各布局状态和未知插件配置分别保留', () => {
    const states = restoreLayoutStates({ filters: [], selection: [], zoom: 260, anchor: 'old', layouts: {
      table: { state: { left: 20 }, anchor: 'row' }, missing: { options: { groupBy: 'x' }, state: { anchors: { a: 'asset' } } }
    } }, 'masonry')
    expect(states.masonry).toEqual({ zoom: 260, anchor: 'old' })
    expect(states.table).toEqual({ state: { left: 20 }, anchor: 'row' })
    expect(states.missing).toEqual({ options: { groupBy: 'x' }, state: { anchors: { a: 'asset' } } })
    expect(restoreLayoutStates({ filters: [], selection: [], zoom: 200, layouts: states }, 'masonry')).toEqual(states)
  })
})

it('工作台预设声明检查命名空间、布局和管理组件，沿用统一启停装配', async () => {
  const { memo } = await import('react')
  const manifest = [{ id: 'demo', title: '示例', description: '' }]
  const layout = { version: 1, primary: 'main', root: { type: 'group', id: 'main' }, panels: { sidebar: true, inspector: false } }
  const preset = { id: 'demo.reading', title: '阅读', layout }
  const ui = { id: 'demo.manager', priority: 100, Component: () => null }
  const check = (p = preset, manager: Omit<typeof ui, 'Component'> & { Component: unknown } = ui) => validateUiContributions([{ id: 'demo', workbenchPresets: [p], workbenchPresetUis: [manager] }], manifest)
  expect(() => check()).not.toThrow()
  expect(() => check(preset, { ...ui, Component: memo(ui.Component) })).not.toThrow()
  expect(() => check(preset, { ...ui, Component: {} })).toThrow('预设界面')
  expect(() => check({ ...preset, id: 'other.preset' })).toThrow('预设声明')
  expect(() => check({ ...preset, layout: { ...layout, primary: 'missing' } })).toThrow('主区域')
  expect(() => check(preset, { ...ui, priority: NaN })).toThrow('预设界面')
  expect(() => validateUiContributions([{ id: 'demo', workbenchPresets: [preset, preset] }], manifest)).toThrow('重复')
})


it('恢复临时条件只合并完整重复项，层级关系与精确条件仍可独立选择', () => {
  const branch: Cond = { op: 'subtree', kind: 'tags', field: 'values', value: 'Math', tree: { kind: 'tree.node', key: 'tag', parent: 'parent' } }
  const reordered: Cond = { tree: { parent: 'parent', key: 'tag', kind: 'tree.node' }, value: 'Math', field: 'values', kind: 'tags', op: 'subtree' }
  const other: Cond = { ...branch, tree: { ...branch.tree, kind: 'other.node' } }
  const exact: Cond = { op: 'eq', kind: 'tags', field: 'values', value: 'Math' }
  const filters = [branch, reordered, other, exact, structuredClone(branch)]
  expect(sameValue(branch, reordered)).toBe(true)
  expect(sameValue(branch, other)).toBe(false)
  expect(sameValue(branch, exact)).toBe(false)
  expect(uniqueCollectionFilters(filters)).toEqual([branch, other, exact])
  expect(filters).toHaveLength(5)
})

it('工具视图与导航分组可声明 dropQuery 接收拖放查询，非函数声明会被拒绝', () => {
  const manifest = [{ id: 'demo', title: '示例', description: '' }]
  const dropQuery = (zone: string) => ({ where: [{ op: 'eq' as const, kind: 'tags', field: 'values', value: zone }] })
  const tool = { id: 'demo.tree', title: '目录', order: 1, Component: () => null, dropQuery }
  const nav = { id: 'demo.nav', order: 10, Component: () => null, dropQuery }
  expect(() => validateUiContributions([{ id: 'demo', toolViews: [tool], navs: [nav] }], manifest)).not.toThrow()
  expect(() => validateUiContributions([{ id: 'demo', toolViews: [{ ...tool, dropQuery: 'bad' }] }], manifest)).toThrow('接收规则')
  expect(() => validateUiContributions([{ id: 'demo', navs: [{ ...nav, dropQuery: 'bad' }] }], manifest)).toThrow('导航分组')
})

it('collectionBlockFacetQuery 可排除指定的临时 has 块以统计模板分面计数，同时保留视图基础 has 规则', () => {
  const params = { title: '全部', query: { has: ['file'] } }
  const state = {
    filters: [{ op: 'eq' as const, kind: 'tags', field: 'values', value: 'UI' }],
    criteria: { has: ['tpl:book', 'note'] }
  }
  const scoped = collectionBlockFacetQuery(params, state, ['tpl:book', 'tpl:movie'])
  expect(replaceHasFilters(state.criteria.has, ['tpl:book', 'tpl:movie'], ['tpl:movie', 'tpl:movie'])).toEqual(['note', 'tpl:movie'])
  expect(() => replaceHasFilters([], ['tpl:book'], ['note'])).toThrow('范围')
  expect(scoped.has).toEqual(['file', 'note'])
  expect(scoped.where).toEqual([{ op: 'eq', kind: 'tags', field: 'values', value: 'UI' }])
})


it('独占字段筛选原子替换列表条件，保留其他字段；默认累加与再次取消保持', () => {
  const red = { op: 'eq', kind: 'colors', field: 'values', value: 'red' } as const
  const blue = { ...red, value: 'blue' }
  const rating = { op: 'range', kind: 'rating', field: 'value', min: 4 } as const
  expect(toggleCollectionFilter([rating, red], blue, true)).toEqual([rating, red, blue])
  expect(toggleCollectionFilter([rating, red, blue], blue, true, true)).toEqual([rating, blue])
  expect(toggleCollectionFilter([rating, blue], blue, true, true)).toEqual([rating])
  expect(toggleCollectionFilter([rating, red], blue, true, true)).toEqual([rating, blue])
  expect(toggleCollectionFilter([rating, red, blue], blue, true)).toEqual([rating, red])
  expect(toggleCollectionFilter([rating, red], blue, false)).toEqual([rating, blue])
})
