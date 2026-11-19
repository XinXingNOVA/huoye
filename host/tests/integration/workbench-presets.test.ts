import { expect, it } from 'vitest'
import { activateEditor, closeEditor, editorsOf, groupOf, insertEditor, splitEditors } from '../../src/renderer/src/editor-layout'
import { defaultWorkspace, type TabEntry, type Workspace } from '../../src/renderer/src/workspace'
import { applyWorkbenchLayout, BUILTIN_LAYOUTS, captureLayoutReturnPoint, captureWorkbenchLayout, LayoutPresetStore, readWorkbenchLayout } from '../../src/renderer/src/workbench-presets'
import { arrangeWorkbench, captureWorkbenchArrangement, inspectWorkbenchArrangement, previewWorkbenchArrangement, type ArrangementEnvironment } from '../../src/renderer/src/workbench-arrangement'
import { collectionWorkbench, libraryPageWorkbench } from '../../src/renderer/src/page-workbench'
import type { TabType, LayoutDef } from '../../src/plugin-api/ui/contracts'
const tab = (id: string): TabEntry => ({ id, type: 'test', params: { id }, state: { draft: '未保存 ' + id } })
const initial = (): Workspace => ({ ...defaultWorkspace(), tabs: [tab('a'), tab('b')], active: 'a', drafts: { secret: 'shared working document' }, sidebars: {
  version: 4, containers: [{ id: 'test.tools', type: 'tabs', side: 'right', views: ['test.missing'], active: 'test.missing' }], selected: { right: 'test.tools' }, hidden: ['test.missing'], weights: { 'test.tools': 2 }
} })
const focus = BUILTIN_LAYOUTS.find(p => p.id === 'host.focus')!.layout
const compare = BUILTIN_LAYOUTS.find(p => p.id === 'host.compare')!.layout

it('保存只有布局，独立副本不携带标签、草稿、素材参数；保留未知插件面板位置', () => {
  const w = splitEditors(initial(), 'right', tab('c'))
  const layout = captureWorkbenchLayout(w), text = JSON.stringify(layout)
  expect(text).not.toContain('shared working document'); expect(text).not.toContain('未保存')
  expect(layout).not.toHaveProperty('tabs'); expect(layout).not.toHaveProperty('drafts')
  expect(layout.sidebars!.containers[0].views).toEqual(['test.missing'])
  layout.sidebars!.hidden.push('extra')
  expect(w.sidebars!.hidden).toEqual(['test.missing'])
  expect(readWorkbenchLayout({ ...layout, tabs: w.tabs, drafts: w.drafts })).not.toHaveProperty('drafts')
})

it('合并保留每个真实页面对象和活动内容；增加区域补开始页，重复切换不积累空页', () => {
  const w = splitEditors(splitEditors(initial(), 'right', tab('c')), 'bottom', tab('d'))
  const joined = applyWorkbenchLayout(w, focus)
  expect(joined.active).toBe('d'); expect(editorsOf(joined).groups).toHaveLength(1)
  expect(joined.drafts).toBe(w.drafts)
  for (const t of w.tabs) expect(joined.tabs.find(v => v.id === t.id)).toBe(t)
  expect(editorsOf(w).groups).toHaveLength(3)
  let current = joined
  for (let i = 0; i < 5; i++) {
    current = applyWorkbenchLayout(current, compare)
    expect(current.tabs.filter(t => t.type === 'workspace.start')).toHaveLength(1)
    expect(editorsOf(current).groups).toHaveLength(2)
    current = applyWorkbenchLayout(current, focus)
    expect(current.tabs).toHaveLength(w.tabs.length)
  }
})

it('命名预设把当前活动组安排到保存的主区域，其他组优先匹配；视图状态不回滚', () => {
  const w = splitEditors(initial(), 'right', tab('c'))
  const layout = captureWorkbenchLayout(w), current = activateEditor(w, 'b')
  const result = applyWorkbenchLayout(current, layout)
  expect(groupOf(result, 'b')!.id).toBe(layout.primary)
  expect(groupOf(result, 'a')!.id).toBe(layout.primary)
  expect(groupOf(result, 'c')!.id).not.toBe(layout.primary)
  expect(new Set(editorsOf(result).groups.flatMap(g => g.tabs))).toEqual(new Set(w.tabs.map(t => t.id)))
  expect(result.tabs).toEqual(w.tabs)
})

it('返回只恢复存活页面的位置；保留后续编辑和新页，不复活关闭页', () => {
  const w = splitEditors(initial(), 'right', tab('c')), point = captureLayoutReturnPoint(w)
  let current = applyWorkbenchLayout(w, focus)
  current = closeEditor(current, 'c', tab('fallback'))
  current = insertEditor(current, tab('new'), groupOf(current)!.id)
  const edited = { ...current.tabs.find(t => t.id === 'a')!, state: { draft: '切换后编辑' } }
  current = { ...current, tabs: current.tabs.map(t => t.id === 'a' ? edited : t) }
  const result = applyWorkbenchLayout(current, point.layout, point.groups)
  expect(result.tabs.some(t => t.id === 'c')).toBe(false)
  expect(result.tabs.find(t => t.id === 'a')).toBe(edited)
  expect(groupOf(result, 'a')!.id).toBe(groupOf(w, 'a')!.id)
  expect(result.active).toBe('new')
  expect(groupOf(result, 'new')!.id).toBe(point.layout.primary)
  expect(result.tabs.filter(t => t.type === 'workspace.start')).toHaveLength(0)
})

it('按仓库保存；明确更新和重命名，删除不影响工作区，失败写入不改变已有预设', () => {
  const data = new Map<string, string>(); let failed = false
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { if (failed) throw new Error('quota'); data.set(k, v) } }
  const a = new LayoutPresetStore(storage, 'a'), b = new LayoutPresetStore(storage, 'b')
  const row = a.save('阅读', captureWorkbenchLayout(initial()))[0]
  expect(b.list()).toEqual([])
  expect(() => a.save(' 阅读 ', focus)).toThrow('同名')
  a.change(row.id, { title: '研究', layout: focus })
  expect(a.list()[0]).toMatchObject({ title: '研究', layout: { panels: { sidebar: false } } })
  failed = true
  expect(() => a.remove(row.id)).toThrow('quota')
  expect(a.list()).toHaveLength(1)
  failed = false; a.remove(row.id); expect(a.list()).toEqual([])
  data.set(a.key, '{bad')
  expect(() => a.save('覆盖', focus)).toThrow()
  expect(data.get(a.key)).toBe('{bad')
})

it('损坏树和未知版本拒绝应用，有限尺寸校验，不接纳重复区域', () => {
  expect(() => readWorkbenchLayout({ ...focus, version: 2 })).toThrow('版本')
  const duplicate = { type: 'split', id: 's', direction: 'columns', ratio: 0.5, first: focus.root, second: focus.root }
  expect(() => readWorkbenchLayout({ ...focus, root: duplicate })).toThrow('重复')
  expect(() => readWorkbenchLayout({ ...compare, root: { ...compare.root, ratio: NaN } })).toThrow('比例')
  expect(() => readWorkbenchLayout({ ...focus, panelSizes: { sidebar: Infinity } })).toThrow('宽度')
})

it('公共服务冻结快照并订阅布局／目录；插件原版只读，用户副本不随更新和停用改变', async () => {
  const { createWorkbenchPresetService } = await import('../../src/renderer/src/workbench-preset-service')
  const data = new Map<string, string>(), store = new LayoutPresetStore({ getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }, 'api')
  let w = initial(), previous: ReturnType<typeof captureLayoutReturnPoint> | undefined
  const actions = { capture: () => captureWorkbenchLayout(w), canReturn: () => !!previous,
    apply: (l: typeof focus) => { previous = captureLayoutReturnPoint(w); w = applyWorkbenchLayout(w, l); return true },
    back: () => { if (!previous) return false; w = applyWorkbenchLayout(w, previous.layout, previous.groups); previous = undefined; return true } }
  const original = { id: 'test.reading', title: '插件预设', layout: captureWorkbenchLayout(w), source: { kind: 'plugin' as const, id: 'test', title: '测试' } }
  const controller = createWorkbenchPresetService(store, actions, [original], []), api = controller.api
  const first = api.getSnapshot(); let notices = 0
  const off = api.subscribe(() => { notices++ })
  expect(Object.isFrozen(first.presets[0].layout.root)).toBe(true)
  controller.refresh(); expect(api.getSnapshot()).toBe(first); expect(notices).toBe(0)
  for (const attempt of [() => api.remove(original.id), () => api.rename(original.id, '错误'), () => api.updateFromCurrent(original.id)]) expect(attempt).toThrow('只读')
  const copyId = api.copy(original.id, '我的副本')
  expect(api.getSnapshot().presets.find(p => p.id === copyId)!.missingViews).toEqual(['test.missing'])
  expect(JSON.stringify([...data.values()])).not.toContain('shared working document')
  original.layout.panels.sidebar = false
  expect(api.getSnapshot().presets[0].layout.panels.sidebar).toBe(true)
  const updated = createWorkbenchPresetService(store, actions, [original], []).api
  expect(updated.getSnapshot().presets[0].layout.panels.sidebar).toBe(false)
  expect(updated.getSnapshot().presets.find(p => p.id === copyId)!.layout.panels.sidebar).toBe(true)
  const disabled = createWorkbenchPresetService(store, actions, [], []).api
  expect(disabled.getSnapshot().presets.map(p => p.id)).toEqual([copyId])
  expect(() => disabled.apply(original.id)).toThrow('未启用')
  disabled.apply(copyId); expect(disabled.getSnapshot().canReturn).toBe(true)
  disabled.back(); expect(disabled.getSnapshot().canReturn).toBe(false)
  const beforeOff = notices; off(); api.rename(copyId, '重命名'); expect(notices).toBe(beforeOff)
})

it('公共服务拒绝忙碌切换、保留失败写入；坏用户目录不阻断内置布局和预览', async () => {
  const { createWorkbenchPresetService } = await import('../../src/renderer/src/workbench-preset-service')
  let value: string | null = null, fail = false, busy = false, invalidCurrent = false, applied = 0
  const store = new LayoutPresetStore({ getItem: () => value, setItem: (_, v) => { if (fail) throw new Error('quota'); value = v } }, 'api')
  const { api, refresh } = createWorkbenchPresetService(store, { capture: () => { if (invalidCurrent) throw new Error('当前布局过大'); return focus }, apply: () => { if (busy) return false; applied++; return true }, canReturn: () => false, back: () => false },
    [{ ...BUILTIN_LAYOUTS[0], source: { kind: 'builtin' } }], [])
  const saved = api.saveCurrent('旧目录'), snapshot = api.getSnapshot()
  fail = true; expect(() => api.rename(saved, '未保存')).toThrow('quota'); expect(api.getSnapshot()).toBe(snapshot)
  busy = true; expect(() => api.apply('host.organize')).toThrow('稍后'); expect(applied).toBe(0)
  busy = false; value = '{bad'; refresh()
  expect(api.getSnapshot().catalogError).toBeTruthy()
  expect(() => api.copy('host.organize', '覆盖')).toThrow()
  expect(value).toBe('{bad'); expect(applied).toBe(0)
  api.apply('host.organize'); expect(applied).toBe(1)
  invalidCurrent = true; expect(refresh).not.toThrow(); expect(api.getSnapshot().currentError).toBe('当前布局过大')
  expect(api.getSnapshot().current).toBeUndefined()
})


it('修改旧预设前备份旧侧栏；备份失败不覆盖目录，成功转换可重复读取', () => {
  const data = new Map<string, string>(); let fail = true
  const store = new LayoutPresetStore({ getItem: k => data.get(k) ?? null, setItem: (k, v) => { if (fail && k.endsWith(':before-sidebars-v4')) throw new Error('备份失败'); data.set(k, v) } }, 'legacy')
  const legacy = JSON.stringify({ version: 1, presets: [{ id: 'old', title: '旧布局', layout: { ...focus, sidebars: { version: 1, containers: [{ id: 'tools', side: 'right', views: ['a', 'b'] }], selected: { right: 'tools' }, collapsed: [], weights: { a: 2 } } } }] })
  data.set(store.key, legacy)
  expect(store.list()[0].layout.sidebars?.version).toBe(4)
  expect(data.get(store.key)).toBe(legacy) // 获取目录没有改写旧存档。
  expect(() => store.change('old', { title: '新名称' })).toThrow('备份失败')
  expect(data.get(store.key)).toBe(legacy)
  fail = false; store.change('old', { title: '新名称' })
  expect(data.get(`${store.key}:before-sidebars-v4`)).toBe(legacy)
  expect(store.list()[0].layout.sidebars?.containers).toHaveLength(2)
})

// 内容编排与几何转换分别覆盖；使用真实集合适配器，不复制业务状态合并逻辑。
const NoView = () => null
const collectionRule: TabType<any, any> = { id: 'collection', Title: NoView, Component: NoView, workbench: collectionWorkbench(
  () => [{ id: 'all', title: '全部', query: { scope: 'content' }, order: 0 }],
  () => [{ id: 'masonry', title: '瀑布流', Component: NoView }, { id: 'table', title: '表格', size: false, Component: NoView }] as LayoutDef[]) }
const env: ArrangementEnvironment = { page: type => type === 'collection' ? collectionRule : type === 'file-spaces' ? { id: type, Title: NoView, Component: NoView, workbench: libraryPageWorkbench, key: () => type, instances: { scope: 'type', max: 1 } } : undefined,
  catalog: { containers: [{ id: 'navigation', side: 'left', title: '导航' }], views: [{ id: 'navigation', title: '导航', container: 'navigation', placement: { regions: ['left', 'center', 'right'] } }], contextTools: [] } }
const prepared = (): Workspace => ({ ...initial(), tabs: [tab('draft'), { id: 'all', type: 'collection', params: { title: '全部', presetId: 'all', query: { scope: 'content' } },
  state: { filters: [{ kind: 'tags', field: 'values', op: 'eq', value: 'Math' }], search: '保留搜索', selection: ['asset'], layouts: { masonry: { zoom: 240, anchor: 'asset' } } } }], active: 'draft' })
const arrangedLayout = () => ({ ...compare, contents: {
  'layout-main': { items: [{ kind: 'page' as const, type: 'collection', target: { presetId: 'all' }, presentation: { layout: 'table', options: { columns: ['file.name'] } } }] },
  'layout-reference': { items: [{ kind: 'page' as const, type: 'file-spaces', target: {} }] }
} })

it('内容编排复用页面并填充新组，重复应用无重复实例，不抢焦点或关闭草稿', () => {
  const w = prepared(), first = arrangeWorkbench(w, arrangedLayout(), env)
  expect(first.issues).toEqual([])
  expect(first.workspace.active).toBe('draft')
  expect(first.workspace.tabs.find(t => t.id === 'draft')).toBe(w.tabs[0])
  const all = first.workspace.tabs.find(t => t.id === 'all')!
  expect(all.state).toMatchObject({ search: '保留搜索', selection: ['asset'], presentation: { layout: 'table' }, layouts: { masonry: { anchor: 'asset' } } })
  expect(all.presentationRevision).toBe(1)
  expect(first.workspace.tabs.filter(t => t.type === 'file-spaces')).toHaveLength(1)
  expect(first.workspace.tabs.some(t => t.type === 'workspace.start')).toBe(false)
  const second = arrangeWorkbench(first.workspace, arrangedLayout(), env).workspace
  expect(second.tabs.map(t => t.id).sort()).toEqual(first.workspace.tabs.map(t => t.id).sort())
  expect(second.tabs.find(t => t.id === 'all')?.presentationRevision).toBe(1)
  const snapshot = captureWorkbenchArrangement(second, env)
  expect(JSON.stringify(snapshot)).not.toMatch(/保留搜索|Math|未保存|shared working|asset/)
  expect(snapshot.contents?.['layout-main'].items[0]).toMatchObject({ kind: 'page', target: { presetId: 'all' }, presentation: { layout: 'table' } })
})

it('返回恢复本次调整的呈现，保留后续搜索、编辑与新页，不复活关闭页', () => {
  const w = prepared(), first = arrangeWorkbench(w, arrangedLayout(), env)
  const changed = { ...first.workspace, tabs: first.workspace.tabs.map(t => t.id === 'all' ? { ...t, state: { ...(t.state as object), search: '新的搜索' } } : t.id === 'draft' ? { ...t, state: { draft: '新编辑' } } : t) }
  const back = arrangeWorkbench(changed, first.point.layout, env, first.point).workspace
  expect(back.tabs.find(t => t.id === 'all')?.state).toMatchObject({ search: '新的搜索', layouts: { masonry: { zoom: 240, anchor: 'asset' } } })
  expect((back.tabs.find(t => t.id === 'all')?.state as any).presentation).toBeUndefined()
  expect(back.tabs.find(t => t.id === 'draft')?.state).toEqual({ draft: '新编辑' })
  expect(back.tabs.some(t => t.type === 'file-spaces')).toBe(true)
  const closed = { ...changed, tabs: changed.tabs.filter(t => t.id !== 'all'), editors: { ...editorsOf(changed), groups: editorsOf(changed).groups.map(g => ({ ...g, tabs: g.tabs.filter(id => id !== 'all') })) } }
  expect(arrangeWorkbench(closed, first.point.layout, env, first.point).workspace.tabs.some(t => t.id === 'all')).toBe(false)
})

it('缺失页面／布局／上下文工具逐项报告；非法描述拒绝且不变更现场', () => {
  const w = prepared(), raw = arrangedLayout()
  raw.contents['layout-main'].items[0].presentation.layout = 'missing-layout'
  raw.contents['layout-reference'].items[0].type = 'missing-page'
  const result = arrangeWorkbench(w, raw, env)
  expect(result.issues.join()).toContain('missing-layout'); expect(result.issues.join()).toContain('missing-page')
  expect(result.workspace.tabs.find(t => t.id === 'all')).toBe(w.tabs[1])
  expect(result.workspace.tabs.filter(t => t.type === 'workspace.start')).toHaveLength(1)
  expect(inspectWorkbenchArrangement({ ...focus, sidebars: { version: 4, containers: [{ id: 'ctx', type: 'context', side: 'left', views: [], active: '', contexts: { collection: { tools: ['missing-tool'] } } }], selected: {}, hidden: [], weights: {} } }, env).join()).toContain('missing-tool')
  expect(() => readWorkbenchLayout({ ...focus, contents: { wrong: { items: [] } } })).toThrow('区域')
  expect(() => readWorkbenchLayout({ ...focus, contents: { 'layout-main': { items: [{ kind: 'tool', id: 'bound:private' }] } } })).toThrow('绑定')
  expect(w.tabs).toHaveLength(2)
  const missingDisplay = { ...w, tabs: w.tabs.map(t => t.id === 'all' ? { ...t, state: { presentation: { layout: 'missing-layout', options: { preserved: true } } } } : t) }
  expect(JSON.stringify(captureWorkbenchArrangement(missingDisplay, env))).toContain('missing-layout')
})

it('工具编排遵守区域能力、保持单实例；返回恢复工具位置，已关闭工具不复活', () => {
  const w = prepared(), raw = { ...compare, contents: { 'layout-reference': { items: [{ kind: 'tool' as const, id: 'navigation' }] } } }
  const first = arrangeWorkbench(w, raw, env)
  expect(first.issues).toEqual([])
  expect(first.workspace.tabs.filter(t => t.type === 'workspace.tool')).toHaveLength(1)
  expect(first.workspace.sidebars?.containers.some(c => c.views.includes('navigation'))).toBe(false)
  const saved = captureWorkbenchArrangement(first.workspace, env)
  expect(saved.contents?.['layout-reference'].items[0]).toEqual({ kind: 'tool', id: 'navigation' })
  const side = { ...focus, sidebars: { version: 4 as const, containers: [{ id: 'navigation', type: 'tabs' as const, side: 'left' as const, views: ['navigation'], active: 'navigation' }], selected: {}, hidden: [], weights: {} } }
  const moved = arrangeWorkbench(first.workspace, side, env)
  expect(moved.workspace.tabs.some(t => t.type === 'workspace.tool')).toBe(false)
  const back = arrangeWorkbench(moved.workspace, moved.point.layout, env, moved.point).workspace
  expect(back.tabs.some(t => t.type === 'workspace.tool')).toBe(true)
  expect(groupOf(back, 'tool:navigation')?.id).toBe('layout-reference')
  const closed = { ...moved.workspace, sidebars: { ...moved.workspace.sidebars!, hidden: ['navigation'] } }
  expect(arrangeWorkbench(closed, moved.point.layout, env, moved.point).workspace.tabs.some(t => t.type === 'workspace.tool')).toBe(false)
  const forbidden = { ...env, catalog: { ...env.catalog, views: env.catalog.views.map(v => ({ ...v, placement: { regions: ['left'] as ('left')[] } })) } }
  expect(arrangeWorkbench(w, raw, forbidden).issues.join()).toContain('不支持')
  const wrongSide = { ...side, sidebars: { ...side.sidebars, containers: side.sidebars.containers.map(c => ({ ...c, side: 'right' as const })) } }
  const stayed = arrangeWorkbench(moved.workspace, wrongSide, forbidden)
  expect(stayed.issues.join()).toContain('不支持')
  expect(stayed.workspace.sidebars?.containers.find(c => c.views.includes('navigation'))?.side).toBe('left')
})

it('页面实例限制由既有规则仲裁；不偷换唯一页的业务身份', () => {
  const unique: TabType = { id: 'unique', Title: NoView, Component: NoView, key: p => String(p.name), instances: { scope: 'type', max: 1 }, workbench: { capture: p => ({ target: p }), resolve: p => p } }
  const registry = { ...env, page: (type: string) => type === 'unique' ? unique : env.page(type) }
  const w = { ...prepared(), tabs: [...prepared().tabs, { id: 'unique', type: 'unique', params: { name: '原内容' }, state: { draft: '不能覆盖' } }] }
  const result = arrangeWorkbench(w, { ...focus, contents: { 'layout-main': { items: [{ kind: 'page', type: 'unique', target: { name: '新内容' } }] } } }, registry)
  expect(result.issues.join()).toContain('最多')
  expect(result.workspace.tabs.find(t => t.id === 'unique')?.state).toEqual({ draft: '不能覆盖' })
})


it('预览通过公共服务只读解析名称与呈现；单项描述失败不阻断其他内容，也不写入目录', async () => {
  const { createWorkbenchPresetService } = await import('../../src/renderer/src/workbench-preset-service')
  const layout = arrangedLayout(), before = structuredClone(layout)
  let writes = 0, applies = 0
  const store = new LayoutPresetStore({ getItem: () => null, setItem: () => { writes++ } }, 'preview')
  const broken: ArrangementEnvironment = { ...env, page: type => type === 'file-spaces' ? {
    ...env.page(type)!, workbench: { ...libraryPageWorkbench, describe: () => { throw new Error('描述失败') } }
  } : env.page(type) }
  const { api } = createWorkbenchPresetService(store, {
    capture: () => layout, apply: () => { applies++; return true }, back: () => false, canReturn: () => false,
    preview: value => previewWorkbenchArrangement(value, broken)
  }, [], [])
  const result = api.preview(layout)
  expect(result.contents['layout-main'][0]).toEqual({ title: '全部', detail: '表格' })
  expect(result.issues.some(v => v.includes('描述失败'))).toBe(true)
  expect(Object.isFrozen(result.contents['layout-main'][0])).toBe(true)
  expect(result.tools).toEqual([{ id: 'navigation', title: '导航' }])
  expect(layout).toEqual(before); expect(writes).toBe(0); expect(applies).toBe(0)
  const missing = structuredClone(layout)
  missing.contents['layout-main'].items[0].target.presetId = 'removed'
  expect(api.preview(missing).issues.some(v => v.includes('未启用'))).toBe(true)
})
