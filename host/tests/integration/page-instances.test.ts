import { expect, it } from 'vitest'
import { chooseCollectionNavigation } from '../../src/renderer/src/collection-navigation'
import { activateEditor, detachEditor, groupOf, insertEditor, resolveEditorOpenTarget, splitEditors } from '../../src/renderer/src/editor-layout'
import { choosePage, otherPageViews } from '../../src/renderer/src/page-instances'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { defaultWorkspace, validWorkspace, type TabEntry } from '../../src/renderer/src/workspace'

const tab = (id: string, content = 'book'): TabEntry => ({ id, type: 'reader', params: { id: content }, state: { page: 2 } })
const key = (params: Record<string, unknown>) => String(params.id)

it('旧页面保持身份复用；显式多开需声明，普通打开优先来源或目标已有视图', () => {
  const tabs = [tab('a'), tab('b')], entry = tab('new')
  expect(choosePage(tabs, entry, { key })).toEqual({ existing: 'a' })
  expect(choosePage(tabs, entry, { key }, { newView: true }).blocked).toContain('尚未开放')
  expect(choosePage(tabs, entry, {})).toEqual({})
  const rule = { key, instances: { scope: 'content' as const } }
  expect(choosePage(tabs, entry, rule, { preferred: ['missing', 'b', 'a'] })).toEqual({ existing: 'b' })
  expect(choosePage(tabs, entry, rule, { newView: true })).toEqual({})
})

it('按内容或类型限制数量；导航不算新增自身，达到限制不替换或删除旧页', () => {
  const tabs = [tab('a'), tab('b'), tab('c', 'other')], entry = tab('new')
  const content = { key, instances: { scope: 'content' as const, max: 2 } }
  expect(choosePage(tabs, entry, { ...content, key: () => undefined as unknown as string }).blocked).toContain('内容身份')
  expect(choosePage(tabs, entry, content, { newView: true }).blocked).toContain('最多打开 2')
  expect(choosePage(tabs, tab('new', 'different'), content, { newView: true })).toEqual({})
  expect(choosePage(tabs, entry, content, { newView: true, omit: 'a' })).toEqual({})
  expect(choosePage(tabs, entry, content, { newView: true, omit: 'c' }).blocked).toBeTruthy()
  expect(choosePage(tabs, tab('new', 'different'), { key, instances: { scope: 'type', max: 3 } }).blocked).toContain('页面类型')
  expect(choosePage(tabs, entry, { instances: { scope: 'type', max: 1 } })).toEqual({ existing: 'a' })
  // 相同素材的另一种页面不是同一内容；复用范围与计数范围分开。
  expect(choosePage([{ ...tab('details'), type: 'details' }], entry, content)).toEqual({})
  expect(choosePage([tab('a')], tab('new', 'different'), { key, instances: { scope: 'type', max: 1 } }).blocked).toContain('页面类型')
  expect(tabs.map(t => t.id)).toEqual(['a', 'b', 'c'])
})

it('同内容快照不共享可变对象；重启保留每个实例，即使新版本收紧数量也不静默丢失存档', () => {
  const tabs = [tab('a'), tab('b'), tab('c', 'other')]
  const copies = otherPageViews(tabs, tabs[0], { key })
  expect(copies.map(v => v.id)).toEqual(['b'])
  copies[0].params.id = 'changed'; (copies[0].saved as { page: number }).page = 9
  expect(tabs[1]).toEqual(tab('b'))
  const restored = validWorkspace({ ...defaultWorkspace(), tabs, active: 'b' }, () => true)!
  expect(restored.tabs).toEqual(tabs)
  expect(choosePage(restored.tabs, tab('new'), { key, instances: { scope: 'content', max: 1 } }, { preferred: ['b'] })).toEqual({ existing: 'b' })
  expect(choosePage(restored.tabs, tab('new'), { key, instances: { scope: 'content', max: 1 } }, { newView: true }).blocked).toBeTruthy()
})

it('装配拒绝无身份的内容规则和无效数量，类型单例合法', () => {
  const check = (instances: { scope: string; max?: number }, keyed = true) => validateUiContributions([{ id: 'demo', tabTypes: [{ id: 'demo.page', key: keyed ? key : undefined, instances }] }], [{ id: 'demo', title: '示例', description: '' }])
  for (const max of [0, -1, 1.5, Infinity, NaN]) expect(() => check({ scope: 'type', max })).toThrow('实例规则')
  expect(() => check({ scope: 'content' }, false)).toThrow('实例规则')
  expect(() => check({ scope: 'group', max: 1 })).toThrow('实例规则')
  expect(() => check({ scope: 'type', max: 1 }, false)).not.toThrow()
})

it('旧编辑中页迁到可卸载界面时保留页面参数、状态及分屏身份', () => {
  const state = { search: '草稿', selection: ['asset'], filters: [], zoom: 200 }
  const w = defaultWorkspace()
  w.tabs = [{ id: 'editing-old', type: 'editing', params: { title: '编辑中', query: { scope: 'content' }, layout: 'masonry' }, state }]
  w.active = 'editing-old'
  const next = validWorkspace(w, type => type === 'file-editing.page')!
  expect(next.active).toBe('editing-old')
  expect(next.tabs[0]).toMatchObject({ id: 'editing-old', type: 'file-editing.page', params: w.tabs[0].params, state })
})

const collection = (id: string, viewId: string): TabEntry => ({ id, type: 'collection', params: { title: '同名视图', query: {}, viewId }, state: { search: id, filters: [] } })
it('集合导航按来源身份定位，保留多份局部状态；只有明确新开才增加同源页面', () => {
  let w = defaultWorkspace()
  const a = collection('a', 'saved'), b = collection('b', 'saved')
  w = insertEditor(insertEditor(w, a), b)
  const before = structuredClone(w), params = { title: '改名', query: {}, viewId: 'saved' }
  expect(chooseCollectionNavigation(w, params)).toEqual({ action: 'activate', id: 'b' })
  expect(chooseCollectionNavigation(activateEditor(w, 'a'), params)).toEqual({ action: 'activate', id: 'a' })
  expect(chooseCollectionNavigation(w, params, { newTab: true })).toEqual({ action: 'open', group: groupOf(w)!.id })
  expect(chooseCollectionNavigation(w, { ...params, viewId: 'different' })).toEqual({ action: 'replace', id: 'b' })
  expect(chooseCollectionNavigation(w, { title: '同名视图', query: {}, presetId: 'saved' })).toEqual({ action: 'replace', id: 'b' })
  expect(chooseCollectionNavigation(w, { title: '同名视图', query: {} })).toEqual({ action: 'replace', id: 'b' })
  expect(w).toEqual(before)
})

it('精简窗保留当前内容，隐式开页跳过精简组；主窗导航固定落在最近主窗组', () => {
  let w = defaultWorkspace()
  const main = groupOf(w)!.id
  w = insertEditor(insertEditor(w, tab('reader')), tab('bucket'))
  w = detachEditor(w, 'reader', 'reader-window')
  w = detachEditor(w, 'bucket', 'mini', { minimal: true })
  const view = { title: '目标', query: {}, viewId: 'saved' }
  expect(w.active).toBe('bucket')
  expect(resolveEditorOpenTarget(w, {}).source.id).toBe('reader-window')
  expect(resolveEditorOpenTarget(w, { originGroup: 'mini' }).source.id).toBe('reader-window')
  expect(resolveEditorOpenTarget(w, { group: 'mini' }).source.id).toBe('mini')
  expect(chooseCollectionNavigation(w, view, { origin: 'bucket' })).toEqual({ action: 'open', group: 'reader-window' })
  expect(chooseCollectionNavigation(w, view, { newTab: true, window: 'main' })).toEqual({ action: 'open', group: main })
  w = activateEditor(w, 'reader')
  expect(chooseCollectionNavigation(w, view, { newTab: true, window: 'main' })).toEqual({ action: 'open', group: main })
})

it('集合导航不跨组抢页或替换阅读页，异步期间换页只新开；失效来源不覆盖新页面', () => {
  let w = defaultWorkspace()
  w = insertEditor(w, collection('a', 'saved'))
  const left = groupOf(w)!.id
  w = splitEditors(w, 'right', tab('reader'))
  const right = groupOf(w)!.id, params = { title: '目标', query: {}, viewId: 'saved' }
  expect(chooseCollectionNavigation(w, params)).toEqual({ action: 'open', group: right })
  expect(chooseCollectionNavigation(w, params, { group: left })).toEqual({ action: 'activate', id: 'a' })
  w = insertEditor(w, collection('b', 'other'))
  expect(chooseCollectionNavigation(w, params, { origin: 'reader', group: right })).toEqual({ action: 'open', group: right })
  expect(chooseCollectionNavigation(w, params, { origin: 'closed', group: 'removed' })).toEqual({ action: 'open', group: right })
  w = insertEditor(w, tab('another-reader'))
  expect(chooseCollectionNavigation(w, { ...params, viewId: 'other' }, {}, ['b'])).toEqual({ action: 'activate', id: 'b' })
})
