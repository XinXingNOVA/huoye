import { uiText } from '../../shared/i18n/interface-display'
import type { PresetInfo, PresetSnapshot, PresetSource, WorkbenchPresetPreview, WorkbenchPresetContribution, WorkbenchPresetService } from '../../plugin-api/ui/workbench-presets'
import { readWorkbenchLayout, type WorkbenchLayout } from '../../shared/workbench-layout'
import { LayoutPresetStore } from './workbench-presets'

export interface PresetActions {
  preview?(layout: WorkbenchLayout): WorkbenchPresetPreview
  inspect?(layout: WorkbenchLayout): string[]
  capture(): WorkbenchLayout | undefined
  apply(layout: WorkbenchLayout): boolean
  canReturn(): boolean
  back(): boolean
}
export interface ProvidedPreset extends WorkbenchPresetContribution { source: Exclude<PresetSource, { kind: 'user' }> }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

/** 窗口所有，只有工作区控制器能实际变更布局。插件和默认 UI 使用同一服务。 */
export function createWorkbenchPresetService(store: LayoutPresetStore, actions: PresetActions, provided: ProvidedPreset[], views: { id: string; title: string }[]) {
  let originals = provided.map(p => ({ ...p, layout: readWorkbenchLayout(p.layout), source: { ...p.source } }))
  const known = new Set(views.map(v => v.id)), listeners = new Set<() => void>()
  let snapshot: PresetSnapshot, signature = ''
  const describe = (p: WorkbenchPresetContribution, source: PresetSource): PresetInfo => ({ id: p.id, title: p.title, ...(p.description === undefined ? {} : { description: p.description }), layout: readWorkbenchLayout(p.layout), source,
    issues: actions.inspect?.(p.layout) ?? [],
    editable: source.kind === 'user', missingViews: p.layout.sidebars?.containers.flatMap(c => c.views).filter(id => !known.has(id)) ?? [] })
  const refresh = () => {
    let users: PresetInfo[] = [], catalogError: string | undefined
    try { users = store.list().map(p => describe(p, { kind: 'user' })) } catch (e) { catalogError = errorText(e) }
    let current: WorkbenchLayout | undefined, currentError: string | undefined
    try { const raw = actions.capture(); current = raw && readWorkbenchLayout(raw) } catch (e) { currentError = errorText(e) }
    const next = { presets: [...originals.map(p => describe(p, p.source)), ...users], views: views.map(v => ({ ...v })),
      current, canReturn: actions.canReturn(), ...(catalogError ? { catalogError } : {}), ...(currentError ? { currentError } : {}) }
    const text = JSON.stringify(next)
    if (text === signature) return
    signature = text; snapshot = freeze(next)
    // 订阅者出错不能把已完成的写入或切换报告成失败，也不能阻断其他订阅者。
    for (const listener of [...listeners]) { try { listener() } catch (e) { console.error('预设订阅回调失败', e) } }
  }
  const find = (id: string) => {
    refresh()
    const p = snapshot.presets.find(p => p.id === id)
    if (!p) throw new Error(uiText("预设已不存在或提供它的插件未启用"))
    return p
  }
  const editable = (id: string) => { if (!find(id).editable) throw new Error(uiText("附带预设是只读原版，请另存副本")) }
  const capture = () => { const layout = actions.capture(); if (!layout) throw new Error(uiText("工作区尚未就绪")); return layout }
  const write = (action: () => void) => { try { action() } finally { refresh() } }
  const save = (title: string, layout: WorkbenchLayout) => {
    let id = ''
    write(() => { id = store.save(title, layout).at(-1)!.id })
    return id
  }
  const api: WorkbenchPresetService = {
    getSnapshot: () => snapshot,
    preview: raw => {
      const layout = readWorkbenchLayout(raw)
      return freeze(actions.preview?.(layout) ?? { contents: {}, tools: views.map(v => ({ ...v })), issues: actions.inspect?.(layout) ?? [] })
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    saveCurrent: title => save(title, capture()),
    copy: (id, title) => save(title, readWorkbenchLayout(find(id).layout)),
    rename: (id, title) => { editable(id); write(() => { store.change(id, { title }) }) },
    updateFromCurrent: id => { editable(id); write(() => { store.change(id, { layout: capture() }) }) },
    remove: id => { editable(id); write(() => { store.remove(id) }) },
    apply: id => {
      const layout = readWorkbenchLayout(find(id).layout)
      if (!actions.apply(layout)) throw new Error(uiText("工作区正在处理页面，请稍后切换布局"))
      refresh()
    },
    back: () => { if (!actions.canReturn()) throw new Error(uiText("没有可返回的布局")); if (!actions.back()) throw new Error(uiText("工作区正在处理页面，请稍后返回")); refresh() }
  }
  refresh()
  return { api: Object.freeze(api), refresh, setProvided: (values: ProvidedPreset[]) => { originals = values.map(p => ({ ...p, layout: readWorkbenchLayout(p.layout), source: { ...p.source } })); refresh() } }
}
