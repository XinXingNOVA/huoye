import { pluginLocalState } from '../plugin-local-state'
import { SettingsController } from '../settings-controller'
import { settingsCatalog } from '../settings-catalog'
import { createWorkbenchCommands } from './workbench-commands'
import type { Intake } from './intake'
import { WorkbenchPresetDialog } from '../components/WorkbenchPresets'
import { createElement, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import type { OpenOptions } from '../../../plugin-api/ui/contracts'
import { libraryFileUrl, localFilePath } from '../../../shared/file-location'
import { pageInputReason } from '../../../shared/page-inputs'
import { isContainer, managementKind } from '../../../shared/blocks'
import type { ContentSelectionChannel } from '../content-selection'
import type { CoreClient } from '../core-client'
import type { EditSessions } from '../editing-sessions'
import { ENTITY_DRAG_TYPE, startEntityDrag } from '../entity-drag'
import { CacheContext } from '../entity-cache'
import type { EditorOpenTarget } from '../editor-layout'
import type { CreationContext, UiHost } from '../plugin'
import { streamService } from '../service-stream'
import { uiExtensions, actionsFor, allKinds, contentLocation, creatorFor, creators, dragOutFor, fileEditingUi, workbenchPresetUi, kindOf, openersFor, overlaysFor, renamerFor, selectionLayers, pageInputsFor, tabTypeOf, titleFor } from '../ui-registry'
import { createFileEditingService } from '../file-editing-service'
import { OpenWithDialog } from '../components/OpenWithDialog'
import { openerChoices, openerType, readOpenerPreference, resolveOpener, saveOpenerPreference } from '../openers'
import { acceleratorLabel } from '../widgets'
import { newTabId } from '../workspace'
import type { PageAccess } from './page-access'
import type { WindowOverlayActions } from './overlays'
import type { WorkspaceController } from './workspace'

interface UiHostOptions {
  presets: import('../../../plugin-api/ui/workbench-presets').WorkbenchPresetService
  core: CoreClient
  root: string
  libraryId: string
  editing: EditSessions
  selection: ContentSelectionChannel
  pages: PageAccess
  intake: Pick<Intake, 'receive' | 'captureTarget' | 'receiveLibrary'>
  busy(): boolean
  presentSettings(target: Required<import('../../../plugin-api/ui/settings').SettingsTarget>): void
  navigation: Pick<WorkspaceController, 'openTab' | 'openCollection' | 'showToolView' | 'activate' | 'togglePanel'>
  overlays: Pick<WindowOverlayActions, 'preview' | 'attach' | 'exportItems' | 'takeout' | 'purge' | 'showDialog' | 'notify'>
}

/** 实现已有 UiHost 契约并绑定页面上下文；页面状态和后端业务仍由各自的所有者处理。 */
export function useUiHost({ presets, core, root, libraryId, editing, selection, pages, navigation, overlays, intake, busy, presentSettings }: UiHostOptions) {
  const fileEditing = useMemo(() => createFileEditingService(window.bridge.fileEditing), [])
  const cache = useContext(CacheContext)!
  const { openTab, showToolView } = navigation
  const showToast = overlays.notify
  const tabHosts = useRef(new Map<string, { parent: UiHost; host: UiHost }>())
  const hostRef = useRef<UiHost>(undefined)

  /** 菜单和 ⌘N 共用：创建、放入指定视图、打开编辑器。 */
  const createNew = useCallback(async (creatorId?: string, context?: CreationContext, destination?: UiHost, scope: 'page' | 'library' = 'page') => {
    const creator = creatorFor(creatorId)
    if (!creator) return showToast('没有可新建的素材类型')
    const tabId = scope === 'library' ? undefined : context?.tabId ?? pages.active()
    const entry = tabId ? pages.entry(tabId) : undefined
    if (tabId && !entry) { showToast('目标页面已关闭，请重新选择新建位置'); return }
    const blocked = pageInputReason(pageInputsFor(entry), 'create')
    if (blocked) { showToast(blocked); return }
    const query = context ? context.query : entry && tabTypeOf(entry.type)?.dropQuery?.(entry.params, entry.state)
    if (query?.scope === 'trash') return showToast('回收站中不能新建素材')

    let id: string
    try {
      id = await core.create(creator.blocks())
    } catch (error) {
      showToast(`新建失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (query) {
      try {
        const { accepted, rejected } = await core.admit([id], query)
        if (accepted.length && tabId === pages.active()) pages.api(tabId!)?.select?.(accepted)
        if (rejected.length) showToast(`已新建${creator.title}，不在当前视图中：${rejected[0].reason}`)
      } catch (error) {
        // 素材已经在库里，即使放入失败也打开，让用户能继续编辑。
        showToast(`已新建${creator.title}，放入视图失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const to = creator.open?.(id)
    if (to) (destination ?? hostRef.current)?.openTab(to.tab, to.params)
    else (destination ?? hostRef.current)?.open(id)
  }, [core, openTab, showToast, pages])

  const openResource = useCallback((id: string, from?: import('../../../plugin-api/ui/navigation').NavigationList, origin?: string, options?: OpenOptions, sourceGroup = pages.group(origin), destination = sourceGroup ? pages.otherGroup(sourceGroup) : undefined) => {
    const source = from ?? pages.api(origin ?? '')?.navigation
    const target: EditorOpenTarget = { group: sourceGroup, placement: options?.group, destination, origin, instance: options?.instance }
    overlays.preview(undefined)
    const perform = async (v: import('../../../shared/blocks').EntityView | undefined, requested?: string, placement = options?.group) => {
      if (!v) throw new Error('素材已不存在')
      const available = v.deletedAt ? [] : openersFor(v)
      const choices = openerChoices(v, available)
      const chosen = resolveOpener(choices, requested, readOpenerPreference(localStorage, libraryId, openerType(v)))
      if (chosen === 'host.system') { await window.bridge.files.openCopy(id); return }
      const opener = (chosen === 'host.auto' ? available[0] : available.find(o => o.id === chosen))?.contribution
      const to = { ...target, placement }
      if (opener && 'open' in opener) {
        const base = (origin && tabHosts.current.get(origin)?.host) || hostRef.current!
        // 回调后续开页只继承位置，不继承本次 opener（防止递归或误用到其他素材）。
        const { opener: _, ...inherited } = options ?? {}
        opener.open(v, {
          ...base,
          open: (asset, from, next) => openResource(asset, from ?? source, origin, { ...inherited, group: to.placement, ...next }, sourceGroup, destination),
          openTab: (type, params, next) => { if (type === 'settings') { void base.openSettings(params).catch(e => showToast(String(e))); return } openTab({ id: newTabId(), type, params }, { ...to, placement: next?.group ?? to.placement, instance: next?.instance ?? to.instance }) },
          openData: (asset, next) => openTab({ id: newTabId(), type: 'data.details', params: { id: asset } }, { ...to, placement: next?.group ?? to.placement, instance: next?.instance ?? to.instance })
        }); return
      }
      openTab(opener && 'tab' in opener ? { id: newTabId(), type: opener.tab, params: opener.params(v, source) }
        : { id: newTabId(), type: 'data.details', params: { id } }, to)
    }
    const show = async (v: import('../../../shared/blocks').EntityView | undefined) => {
      if (options?.opener !== 'host.choose') return perform(v, options?.opener)
      if (!v || v.deletedAt) throw new Error('素材不存在或已在回收站')
      const type = openerType(v)
      overlays.showDialog(close => createElement(OpenWithDialog, {
        title: titleFor(v), choices: openerChoices(v, openersFor(v)), type,
        preferred: readOpenerPreference(localStorage, libraryId, type), other: options.group === 'other', close,
        open: async (choice, remember, other) => {
          const [fresh] = await core.get([id])
          if (!fresh || fresh.deletedAt) throw new Error('素材不存在或已在回收站')
          if (openerType(fresh) !== type) throw new Error('文件类型已改变，请重新打开选择窗口')
          await perform(fresh, choice.id, other ? 'other' : 'current')
          if (remember && type) {
            try { saveOpenerPreference(localStorage, libraryId, type, choice) }
            catch { showToast('已打开，但默认方式未能保存') }
          }
        }
      }))
    }
    const cached = cache.get(id)
    void (cached ? show(cached) : core.get([id]).then(vs => show(vs[0]))).catch(e => showToast(`打开失败：${e instanceof Error ? e.message : String(e)}`))
  }, [cache, core, openTab, showToast, pages, overlays, libraryId])

  const showActions = useCallback((ids: string[], context: UiHost) => {
    if (!ids.length) return
    void core.get(ids).then(async views => {
      const { items, byId } = actionsFor(views)
      if (!items.length) return
      const chosen = await window.bridge.contextMenu(items)
      const action = chosen ? byId.get(chosen) : undefined
      if (action) await action.run(views, context)
    }).catch(error => showToast(error instanceof Error ? error.message : String(error)))
  }, [core, showToast])

  const presentRef = useRef(presentSettings)
  presentRef.current = presentSettings
  const settings = useMemo(() => new SettingsController(settingsCatalog, target => presentRef.current(target)), [])
  const commandOptions = useRef({ pages, intake, busy, create: createNew, activate: navigation.activate, openCollection: navigation.openCollection, togglePanel: navigation.togglePanel })
  commandOptions.current = { pages, intake, busy, create: createNew, activate: navigation.activate, openCollection: navigation.openCollection, togglePanel: navigation.togglePanel }
  const commandExecution = useRef({ busy: false })
  const commandServices = useRef(new Map<string, ReturnType<typeof createWorkbenchCommands>>())
  const commandsFor = (id?: string) => {
    const key = id ?? ''
    let service = commandServices.current.get(key)
    if (!service) {
      service = createWorkbenchCommands({
        pages, host: source => hostForContext(hostRef.current!, source, { group: pages.group(source), destination: pages.group(source) ? pages.otherGroup(pages.group(source)!) : undefined, navigation: structuredClone(pages.api(source ?? '')?.navigation) }),
        create: (...args) => commandOptions.current.create(...args),
        openCollection: (...args) => commandOptions.current.openCollection(...args),
        createInLibrary: (id, host) => commandOptions.current.create(id, undefined, host, 'library'),
        intake: { receiveLibrary: (...args) => commandOptions.current.intake.receiveLibrary(...args), receive: (...args) => commandOptions.current.intake.receive(...args), captureTarget: (...args) => commandOptions.current.intake.captureTarget(...args) },
        busy: () => commandOptions.current.busy(), activate: id => commandOptions.current.activate(id), togglePanel: side => commandOptions.current.togglePanel(side)
      }, id ? () => id : undefined, commandExecution.current)
      commandServices.current.set(key, service)
    }
    return service
  }
  useEffect(() => () => { settings.dispose(); commandServices.current.forEach(service => service.dispose()); commandServices.current.clear() }, [settings])

  const host = useMemo<UiHost>(
    () => ({
      localState: pluginLocalState,
      extensions: uiExtensions(),
      settings,
      openSettings: async target => {
        const opened = await settings.open(target)
        if (!opened) showToast(settings.getSnapshot().blockedReason ?? '设置正在处理，请稍候')
        return opened
      },
      commands: { createSession: () => commandsFor().createSession() },
      core,
      selection,
      editing,
      fileEditing,
      workbenchPresets: presets,
      pluginPresets: window.bridge.pluginPresets,
      openWorkbenchPresets: (intent = 'manage') => overlays.showDialog(close => createElement(WorkbenchPresetDialog, { provider: workbenchPresetUi(), host: hostRef.current!, intent, close })),
      selectionLayers,
      revealContent: (reference, focus) => {
        try {
          const provider = contentLocation(reference.locator.provider, reference.locator.version)
          const target = provider?.open(reference, focus)
          if (target && tabTypeOf(target.tab)) { hostRef.current!.openTab(target.tab, target.params); return }
          showToast('来源阅读器不可用或位置格式不支持，已保留摘录原文')
        } catch (error) { showToast(`无法定位原文：${String(error)}`) }
        hostRef.current!.openData(focus ?? reference.sourceId)
      },
      showView: showToolView,
      service: (plugin, method, input) => window.bridge.services.invoke(plugin, method, input),
      streamService,
      root,
      startDrag: (event, ids) => {
        try { startEntityDrag(event, ids, (id) => cache.get(id), (view) => dragOutFor(view, hostRef.current!), (files, icon) => window.bridge.startDrag(files, icon)) }
        catch (error) { event.preventDefault(); showToast(error instanceof Error ? error.message : String(error)) }
      },
      contextMenu: (items) => window.bridge.contextMenu(items),
      overlays: overlaysFor,
      // lib://<素材库 ID>/…：主进程按 ID 找到是哪个仓库（可以同时开着几个）
      url: (rel, version) => libraryFileUrl(libraryId, rel, version),
      abs: (rel) => /^(shared|spaces)\//.test(rel.replaceAll('\\', '/')) ? window.bridge.files.resolve(rel) : localFilePath(root, rel),
      kind: kindOf,
      kinds: allKinds,
      title: titleFor,
      reveal: (abs) => void window.bridge.reveal(abs),
      openExternal: (url) => void window.bridge.openExternal(url),
      toggleFilter: (cond, options) => {
        const filter = pages.api(pages.active() ?? '')?.toggleFilter
        if (filter) filter(cond, options)
        else if (options?.exclusive) showToast('当前页面不支持筛选，请先打开一个集合视图')
      },
      preview: (id) => overlays.preview(id),
      open: (id, from, options) => openResource(id, from, pages.active(), options),
      openTab: (type, params, options) => { if (type === 'settings') { void hostRef.current!.openSettings(params).catch(e => showToast(String(e))); return } overlays.preview(undefined); openTab({ id: newTabId(), type, params }, { placement: options?.group, instance: options?.instance }) },
      editFile: (id, options) => {
        const ui = fileEditingUi()
        if (!ui) { showToast('请先安装并启用文件编辑插件；已有工作副本仍保留'); return }
        void Promise.resolve().then(() => ui.open({ id, intent: options?.intent }, hostRef.current!)).catch(e => showToast(String(e)))
      },
      openData: (id, options) => { overlays.preview(undefined); openTab({ id: newTabId(), type: 'data.details', params: { id } }, { placement: options?.group, instance: options?.instance }) },
      quickAttach: (ids) => {
        if (ids.length) void core.get(ids).then(views => {
          if (views.some(v => managementKind(v.blocks, kindOf))) showToast('插件管理数据只能在所属插件中管理')
          else if (views.some(v => isContainer(v.blocks, kindOf))) showToast('请在容器检查器中编辑此项，或仅选择普通素材进行快速附加')
          else overlays.attach(ids)
        }).catch(e => showToast(String(e)))
      },
      notify: (text) => showToast(text),
      export: (ids, name) => {
        if (ids.length) overlays.exportItems(ids, name)
      },
      takeout: (ids, name) => {
        if (ids.length) { overlays.preview(undefined); overlays.takeout(ids, name) }
      },
      trash: (ids) => {
        if (!ids.length) return
        void core.trash(ids).then(() => showToast(`已移到回收站${ids.length > 1 ? `（${ids.length} 项）` : ''}，可以撤销（${acceleratorLabel('CmdOrCtrl+Z')}）`)).catch(e => showToast(String(e)))
      },
      purge: (ids) => {
        if (ids.length) overlays.purge(ids)
      },
      rename: (ids) => {
        if (!ids.length) return
        void core.get(ids).then((views) => {
          const live = views.filter((v) => !v.deletedAt)
          const rename = renamerFor(live)
          if (rename && live.length === views.length && hostRef.current) rename(live, hostRef.current)
          else showToast(views.some((v) => v.deletedAt) ? '回收站里的不能改名' : views.length > 1 ? '这些素材不能一起改名' : '这个素材不能改名')
        })
      },
      showDialog: (render) => overlays.showDialog(render),
      showActions: ids => hostForContext(hostRef.current!, pages.active()).showActions(ids),
      showCreateMenu: (context) => {
        const entry = pages.entry(context.tabId)
        if (!entry || context.query?.scope === 'trash' || pageInputReason(pageInputsFor(entry), 'create')) return
        const items = creators().map((c) => ({ id: c.id, label: `新建${c.title}` }))
        if (!items.length) return
        void window.bridge.contextMenu(items).then((chosen) => {
          if (chosen && items.some((item) => item.id === chosen)) void createNew(chosen, context)
        })
      },
      idsFromDrop: (dt) => {
        const internal = dt.getData(ENTITY_DRAG_TYPE)
        if (internal) return JSON.parse(internal) as string[]
        return window.bridge.files.identify([...dt.files].map(f => window.bridge.pathForFile(f)))
          .filter((id): id is string => !!id)
      }
    }),
    [settings, presets, core, root, libraryId, cache, openTab, showToast, createNew, showToolView, openResource, showActions, selection, editing, fileEditing, pages, overlays]
  )
  hostRef.current = host
  const hostForContext = (base: UiHost, id?: string, fixed?: { group?: string; destination?: string; navigation?: import('../../../plugin-api/ui/navigation').NavigationList }): UiHost => {
    const group = () => fixed ? fixed.group : pages.group(id)
    const destination = () => fixed ? fixed.destination : group() ? pages.otherGroup(group()!) : undefined
    const navigation = () => fixed ? fixed.navigation : pages.api(id ?? '')?.navigation
    const open = (type: string, params: Record<string, unknown>, options?: OpenOptions) => {
      if (type === 'settings') { void base.openSettings(params).catch(e => showToast(String(e))); return }
      overlays.preview(undefined)
      openTab({ id: newTabId(), type, params }, { group: group(), placement: options?.group, destination: destination(), origin: id, instance: options?.instance })
    }
    return {
      ...base,
      commands: { createSession: () => commandsFor(id).createSession() },
      open: (asset, from, options) => openResource(asset, from ?? navigation(), id, options, group(), destination()),
      openTab: open,
      openData: (asset, options) => open('data.details', { id: asset }, options),
      toggleFilter: (cond, options) => {
        const filter = pages.api(id ?? '')?.toggleFilter
        if (filter) filter(cond, options)
        else if (options?.exclusive) showToast('当前页面不支持筛选，请先打开一个集合视图')
      },
      showActions: ids => showActions(ids, hostForContext(base, id, { group: group(), destination: destination(), navigation: navigation() }))
    }
  }
  const hostForTab = (id: string): UiHost => {
    const cached = tabHosts.current.get(id)
    if (cached?.parent === host) return cached.host
    const scoped = hostForContext(host, id)
    tabHosts.current.set(id, { parent: host, host: scoped })
    return scoped
  }

  const forgetTab = useCallback((id: string) => { tabHosts.current.delete(id); commandServices.current.get(id)?.dispose(); commandServices.current.delete(id) }, [])
  return { host, hostForTab, forgetTab, createNew }
}
