import { createWorkbenchSession, workspaceContextChanged } from '../workbench-session'
import { useWorkspaceWindows } from './workspace-windows'
import { focusContentDocument } from '../display-windows'
import { closeDockTool, reconcileToolWorkspace } from '../tool-docking'
import { toolIdOf } from '../workspace'
import { pageContext } from '../page-context'
import { useContainerActions } from './container-actions'
import { describeSidebarContainers } from '../workbench-containers'
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ContentSelectionChannel } from '../content-selection'
import type { EditSessions } from '../editing-sessions'
import { syncViewSource } from '../collection-query'
import { CacheContext } from '../entity-cache'
import { activateEditor, closeEditor, resolveEditorOpenTarget, editorsOf, groupOf, otherGroup, canSplitEditor, splitMoveEditor, balanceEditors, openEditor, type EditorOpenTarget, type EditorEdge, joinEditors, moveEditor, replaceEditor, resizeEditors, splitEditors, visibleTabs } from '../editor-layout'
import { allowsNewView, choosePage } from '../page-instances'
import { chooseCollectionNavigation, type CollectionNavigationTarget } from '../collection-navigation'
import type { CollectionParams } from '../workspace'
import type { KeyHandler, TabApi } from '../plugin'
import { sidebarCatalog } from '../sidebar-catalog'
import { readSidebars } from '../sidebar-layout'
import { tabTypeOf } from '../ui-registry'
import { ALL_VIEW, collectionTab, defaultWorkspace, extractLegacySettingsTarget, newTabId, startTab, validWorkspace, withStableDocks, type TabEntry, type Workspace } from '../workspace'
import type { PageAccess, PageHosts } from './page-access'
import { usePageLifecycle } from './lifecycle'
import { useWorkspaceDocking } from './workspace-docking'
import { useWorkspacePresets } from './workspace-presets'
import { measureEditorGroup } from '../components/workbench-geometry'

/** 常驻的标签页数量：其余卸下界面，只留存档。可见分屏仍全部挂载。 */
const KEEP_ALIVE = 3
const sameIds = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i])

export interface TabCallbacks {
  setState(state: unknown): void
  setParams(params: Record<string, unknown>): void
  setFocus(ids: string[]): void
  registerKeys(h: KeyHandler | null): void
  expose(api: TabApi | null): void
}

interface WorkspaceOptions {
  core: import('../core-client').CoreClient
  libraryId: string
  editing: EditSessions
  draftTick: number
  selection: ContentSelectionChannel
  hosts: PageHosts
  beforePrepare?(reason: 'reload' | 'shutdown', signal: AbortSignal): Promise<void>
  onLegacySettings?(target: { scope?: 'application' | 'library'; section?: string }): void
  notify(text: string): void
  reportSaveError(text: string): void
}

/** 工作区与页面注册的唯一所有者。对外给快照、只读页面访问和有语义的动作，不暴露 setState。 */
export function useWorkspace({ core, libraryId, editing, draftTick, selection, hosts, beforePrepare, onLegacySettings, notify: showToast, reportSaveError }: WorkspaceOptions) {
  const cache = useContext(CacheContext)!
  const [catalog] = useState(sidebarCatalog)
  const [ws, setWs] = useState<Workspace>()
  const [loadError, setLoadError] = useState('')
  useLayoutEffect(() => { selection.activate(ws?.active) }, [selection, ws?.active])
  const [mru, setMru] = useState<string[]>([])
  const mruRef = useRef(mru)
  mruRef.current = mru
  const [focus, setFocus] = useState<Record<string, string[]>>({})
  const [apis, setApis] = useState<Record<string, TabApi | null>>({})
  const activeRef = useRef<string | undefined>(ws?.active)
  activeRef.current = ws?.active
  const wsRef = useRef(ws)
  wsRef.current = ws
  const apisRef = useRef(apis)
  apisRef.current = apis
  const focusRef = useRef(focus)
  focusRef.current = focus
  const tabKeys = useRef(new Map<string, KeyHandler>())
  const callbacks = useRef(new Map<string, TabCallbacks>())

  const sessionEpoch = useRef(0)
  const readWorkspace = useCallback(() => wsRef.current, [])
  const lifecycle = usePageLifecycle({ libraryId, snapshot: ws, readWorkspace, editing, draftTick, hosts, beforePrepare, notify: showToast, reportSaveError })
  const { transitions, changePage } = lifecycle
  const legacySettingsRef = useRef(onLegacySettings)
  legacySettingsRef.current = onLegacySettings

  useEffect(() => {
    window.bridge.loadWorkspace(libraryId).then((data) => {
      const savedSidebars = (data as Workspace | undefined)?.sidebars
      if (savedSidebars !== undefined && !readSidebars(savedSidebars)) throw new Error('侧栏布局版本未知或格式损坏，原有存档未覆盖')
      editing.restore((data as Workspace | undefined)?.drafts)
      const legacySettings = extractLegacySettingsTarget(data)
      const w = validWorkspace(data, (t) => !!tabTypeOf(t)) ?? defaultWorkspace()
      const stable = withStableDocks(w, tabTypeOf(w.tabs.find(t => t.id === w.active)!.type)?.panels)
      setWs(reconcileToolWorkspace(stable, catalog))
      setMru([w.active])
      if (legacySettings) legacySettingsRef.current?.(legacySettings)
    }).catch(error => setLoadError(String(error)))
  }, [libraryId, catalog, editing])

  const update = useCallback((fn: (w: Workspace) => Workspace) => {
    const previous = wsRef.current
    if (!previous) return
    const next = fn(previous)
    if (next === previous) return
    if (workspaceContextChanged(previous, next)) sessionEpoch.current++
    // 捕获阶段切组后，子组件同一事件中的宿主调用立即读到新的操作目标。
    wsRef.current = next; activeRef.current = next.active; setWs(next)
  }, [])
  const savedViewIds = JSON.stringify([...new Set(ws?.tabs.flatMap(t => t.type === 'collection' && typeof t.params.viewId === 'string' ? [t.params.viewId] : []) ?? [])].sort())
  useEffect(() => {
    // 使用现有实体缓存合并订阅；即使页面被冻结，拖入目标也沿用最新保存规则。
    const offs = (JSON.parse(savedViewIds) as string[]).map(id => {
      const sync = () => update(w => syncViewSource(w, id, cache.getSnapshot(id)))
      const off = cache.subscribe(id, sync); sync(); return off
    })
    return () => offs.forEach(off => off())
  }, [savedViewIds, cache, update])
  const activate = useCallback(
    (id: string) => {
      if (transitions.busy) return
      update((w) => activateEditor(w, id))
      selection.activate(activeRef.current)
      focusContentDocument(id, wsRef.current && groupOf(wsRef.current, id)?.id)
      setMru((m) => m[0] === id ? m : [id, ...m.filter((x) => x !== id)].slice(0, KEEP_ALIVE))
    },
    [update, selection, transitions]
  )

  const pages = useMemo<PageAccess>(() => ({
    entries: () => wsRef.current?.tabs ?? [],
    group: id => wsRef.current && groupOf(wsRef.current, id)?.id,
    otherGroup: group => wsRef.current && otherGroup(editorsOf(wsRef.current), group)?.id,
    active: () => activeRef.current,
    entry: id => wsRef.current?.tabs.find(t => t.id === id),
    api: id => apisRef.current[id],
    focus: id => focusRef.current[id] ?? [],
    keys: id => tabKeys.current.get(id),
    activeGroupTabs: () => wsRef.current ? groupOf(wsRef.current)?.tabs ?? [] : [],
    groupActive: id => wsRef.current && editorsOf(wsRef.current).groups.find(g => g.id === id)?.active
  }), [])
  const sidebarActions = useContainerActions({ read: readWorkspace, update, catalog, pages, transitions, activate, notify: showToast })
  const togglePanel = useCallback((panel: keyof Workspace['panels']) => {
    const w = wsRef.current
    if (w) sidebarActions.setVisible(panel === 'sidebar' ? 'left' : 'right', !w.panels[panel])
  }, [sidebarActions])

  const openTab = useCallback(
    (entry: TabEntry, target: EditorOpenTarget = {}) => {
      if (transitions.busy) return
      const w = wsRef.current, rule = tabTypeOf(entry.type)
      if (!w || !rule) return
      const { source: origin, destination } = resolveEditorOpenTarget(w, target)
      const preferred = [destination?.active, target.origin, origin.active, w.active, ...mruRef.current].filter((id): id is string => !!id)
      const decision = choosePage(w.tabs, entry, rule, { newView: target.instance === 'new', preferred })
      if (decision.blocked) { showToast(decision.blocked); return }
      if (target.placement === 'other' && !destination) {
        const rect = measureEditorGroup(origin.id)
        if (!rect || !canSplitEditor({ x: 0, y: 0, width: rect.width, height: rect.height }, 'right')) { showToast('区域太窄，无法向右分割；可先收起侧栏或调整区域大小'); return }
      }
      // 命中同身份页只是更新打开意图并定位，没有结束旧内容；保持同步焦点路由。
      update(w => openEditor(w, entry, target, decision.existing, startTab()))
      const id = decision.existing ?? entry.id
      focusContentDocument(id, wsRef.current && groupOf(wsRef.current, id)?.id)
      setMru(m => [id, ...m.filter(x => x !== id)].slice(0, KEEP_ALIVE))
    },
    [update, showToast, transitions]
  )

  /** 在原位置换成另一个标签页（侧栏点视图时）。 */
  const replaceTab = useCallback((id: string, entry: TabEntry) => {
    const w = wsRef.current, rule = tabTypeOf(entry.type)
    if (!w || !rule) return
    const decision = choosePage(w.tabs, entry, rule, { omit: id, preferred: [w.active, ...mruRef.current] })
    if (decision.blocked) { showToast(decision.blocked); return }
    if (decision.existing) { activate(decision.existing); return }
    changePage(id, 'replace', () => {
      update(w => replaceEditor(w, id, entry))
      hosts.forget(id)
      setMru(m => m.map(x => x === id ? entry.id : x))
      callbacks.current.delete(id)
    })
  }, [update, changePage, showToast, activate, hosts])

  /** 导航、命令与快捷入口共用；显式 openTab 仍保留原有开页语义。 */
  const openCollection = useCallback((params: CollectionParams, target: CollectionNavigationTarget = {}) => {
    const w = wsRef.current
    if (!w || transitions.busy) return
    const next = chooseCollectionNavigation(w, params, target, mruRef.current)
    if (next.action === 'activate') activate(next.id)
    else if (next.action === 'replace') replaceTab(next.id, collectionTab(params))
    else openTab(collectionTab(params), { group: next.group })
  }, [activate, replaceTab, openTab, transitions])

  const closeTab = useCallback((id: string) => {
    const tool = toolIdOf(wsRef.current?.tabs.find(t => t.id === id))
    if (tool) return Promise.resolve(sidebarActions.closeTool(tool))
    return changePage(id, 'close', () => {
      update(w => closeEditor(w, id, collectionTab(ALL_VIEW)))
      const active = wsRef.current?.active
      setMru(m => active ? [active, ...m.filter(x => x !== id && x !== active)].slice(0, KEEP_ALIVE) : [])
      hosts.forget(id)
      callbacks.current.delete(id)
      tabKeys.current.delete(id)
      setApis(({ [id]: _, ...rest }) => rest)
      setFocus(({ [id]: _, ...rest }) => rest)
    })
  }, [update, changePage, hosts, sidebarActions])

  const cycle = useCallback(
    (step: number) => {
      const w = wsRef.current
      if (!w) return
      const tabs = groupOf(w)!.tabs
      const i = tabs.indexOf(w.active)
      activate(tabs[(i + step + tabs.length) % tabs.length])
    },
    [activate]
  )

  const callbacksFor = (id: string): TabCallbacks => {
    let c = callbacks.current.get(id)
    if (!c) {
      c = {
        setState: (state) => update((w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === id ? { ...t, state } : t)) })),
        setParams: params => {
          const current = wsRef.current?.tabs.find(t => t.id === id)
          if (!current) return
          const rule = tabTypeOf(current.type)
          if (!rule || transitions.busy) return
          const key = rule.key?.(params), unchanged = key !== undefined && key === rule.key?.(current.params)
          if (!unchanged) {
            const decision = choosePage(wsRef.current!.tabs, { ...current, params }, rule, { omit: id, newView: allowsNewView(rule), preferred: [activeRef.current!, ...mruRef.current] })
            if (decision.blocked) { showToast(decision.blocked); return }
            if (decision.existing) { activate(decision.existing); return }
          }
          const commit = () => update(w => ({ ...w, tabs: w.tabs.map(t => t.id === id ? { ...t, params, state: key !== undefined && key !== rule.key?.(t.params) ? undefined : t.state } : t) }))
          if (unchanged) commit()
          else changePage(id, 'navigate', commit, params)
        },
        setFocus: ids => {
          if (sameIds(focusRef.current[id], ids)) return
          sessionEpoch.current++
          focusRef.current = { ...focusRef.current, [id]: ids }; setFocus(focusRef.current)
        },
        registerKeys: (h) => {
          if (h) tabKeys.current.set(id, h)
          else tabKeys.current.delete(id)
        },
        expose: api => { apisRef.current = { ...apisRef.current, [id]: api }; setApis(apisRef.current) }
      }
      callbacks.current.set(id, c)
    }
    return c
  }

  const windows = useWorkspaceWindows({ read: readWorkspace, update, catalog, pages, transitions, notify: showToast })
  const docking = useWorkspaceDocking({ read: readWorkspace, update, catalog, pages, transitions, notify: showToast, detach: windows.detachTool })

  const editorActions = useMemo(() => ({
    onDetach: windows.detachPage,
    onReturn: windows.returnGroup,
    onWindowBounds: windows.bounds,
    onDuplicate(id: string, group: string, destination?: string) {
      const entry = wsRef.current?.tabs.find(t => t.id === id)
      if (entry) openTab({ ...structuredClone(entry), id: newTabId() }, { origin: id, group, destination, placement: 'other', instance: 'new' })
    },
    onSelect: activate,
    onClose: closeTab,
    onNew: (group: string) => openTab(collectionTab(ALL_VIEW), { group }),
    onMove(id: string, group: string, before?: string) { if (transitions.busy) return; update(w => moveEditor(w, id, group, before)); activate(id) },
    onSplit(group: string, edge: EditorEdge, tab?: string) {
      if (transitions.busy || editorsOf(readWorkspace()!).groups.find(g => g.id === group)?.window) return
      const rect = measureEditorGroup(group)
      if (!rect || !canSplitEditor({ x: 0, y: 0, width: rect.width, height: rect.height }, edge)) { showToast('区域空间不足，可先收起侧栏或调整区域大小'); return }
      update(w => tab ? splitMoveEditor(w, tab, group, edge, startTab()) : splitEditors(w, edge, startTab(), group)); activate(wsRef.current!.active)
    },
    onJoin(source?: string, target?: string) { update(w => joinEditors(w, source, target)); activate(wsRef.current!.active) },
    onBalance: () => update(balanceEditors),
    onResize: (id: string, ratio: number) => update(w => resizeEditors(w, id, ratio))
  }), [windows, activate, closeTab, openTab, update, showToast, transitions, readWorkspace])
  const releasePages = useCallback((ids: string[]) => {
    if (!ids.length) return
    const removed = new Set(ids)
    for (const id of removed) { hosts.forget(id); callbacks.current.delete(id); tabKeys.current.delete(id) }
    setMru(m => m.filter(id => !removed.has(id)))
    setApis(a => Object.fromEntries(Object.entries(a).filter(([id]) => !removed.has(id))))
    setFocus(f => Object.fromEntries(Object.entries(f).filter(([id]) => !removed.has(id))))
  }, [hosts])
  const closeContentWindow = useCallback((groupId: string) => {
    const ids = editorsOf(readWorkspace()!).groups.find(g => g.id === groupId && g.window)?.tabs
    if (!ids?.length) return Promise.resolve(true)
    return lifecycle.changePages([...ids], () => {
      update(w => ids.reduce((next, id) => {
        const tool = toolIdOf(next.tabs.find(t => t.id === id))
        return tool ? closeDockTool(next, tool, catalog) : closeEditor(next, id, collectionTab(ALL_VIEW))
      }, w))
      releasePages(ids)
    })
  }, [readWorkspace, lifecycle.changePages, update, catalog, releasePages])
  const { api: presets, control: presetControl } = useWorkspacePresets({ core, libraryId, snapshot: ws, read: readWorkspace, update, catalog, transitions, releasePages, checkpoint: lifecycle.checkpoint, notify: showToast })
  const sessionControl = useMemo(() => createWorkbenchSession({ read: readWorkspace, epoch: () => sessionEpoch.current, busy: () => transitions.busy, pages, core, open: openTab }), [readWorkspace, transitions, pages, core, openTab])
  useEffect(() => window.bridge.workbenchControl.onRequest((input, authorize) => input.action === 'session'
    ? sessionControl(input.request, input.windows, authorize) : presetControl(input, authorize)), [sessionControl, presetControl])
  const contexts = ws?.tabs.flatMap(t => pageContext(pages, t.id) ?? []) ?? []
  const sidebarSnapshot = ws && describeSidebarContainers(ws, catalog, contexts)
  return { presets, loadError, snapshot: ws, catalog, pages, lifecycle, alive: new Set([...(ws ? visibleTabs(ws) : []), ...mru, ...Object.values(ws?.sidebars?.bindings ?? {}).filter(b => catalog.contextTools.some(t => t.id === b.toolId && t.context.detachable)).map(b => b.pageId)]),
    closeContentWindow, activate, openTab, replaceTab, openCollection, closeTab, cycle, togglePanel, showToolView: sidebarActions.showTool, callbacksFor, editorActions, sidebarActions, sidebarSnapshot, contexts, docking }
}

export type WorkspaceController = ReturnType<typeof useWorkspace>
