import { CollectionLibraryContext } from './use-collection-layout'
// 一个仓库窗口的装配入口：窗口级服务、内部控制模块与画面。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useCommandPalette } from './app/command-palette'
import { useSettingsWindow } from './app/settings-window'
import { useIntake } from './app/intake'
import { useTransferInput } from './app/transfer'
import { useWindowCommands } from './app/commands'
import { useWorkspace } from './app/workspace'
import { useUiHost } from './app/ui-host'
import { useWindowOverlays, WindowOverlays, WindowNotices } from './app/overlays'
import { DisplayPortal } from './DisplayPortal'
import { ContentWindows } from './components/ContentWindows'
import { EditorSurfaces } from './components/EditorSurfaces'
import { EditorDragProvider } from './components/EditorDrag'
import { TabHost } from './app/TabHost'
import type { PageHosts } from './app/page-access'
import { AdmissionFeedback } from './components/AdmissionFeedback'
import { ViewImportReview } from './components/ViewImportReview'
import { EditSessions } from './editing-sessions'
import { ContentSelectionChannel } from './content-selection'
import { ContentSelectionMenu } from './components/ContentSelectionMenu'
import { CommandPalette } from './components/CommandPalette'
import { DevelopmentNotice } from './components/DevelopmentPlugins'
import { Inspector } from './components/Inspector'
import { SettingsWindow } from './components/SettingsWindow'
import { Sidebar } from './components/Sidebar'
import { WindowProviders } from './components/WindowContributions'
import { ToolViewSurfaces } from './components/ToolViewSurfaces'
import { ToolDragProvider } from './components/ToolDrag'
import { SurfaceHost } from './surface-slots'
import { SidebarWorkspace } from './components/SidebarWorkspace'
import { EditorWorkspace } from './components/EditorWorkspace'
import { PanelToggle } from './components/PanelToggle'
import type { CoreClient } from './core-client'
import { tabTypeOf } from './ui-registry'
import { portablePath } from '../../shared/paths'
import { panelWidths, type CollectionParams } from './workspace'

export interface AppProps {
  core: CoreClient
  root: string
  libraryId: string
  unavailable: { plugin: string; reason: string }[]
}

export function App({ core, root, libraryId, unavailable }: AppProps) {
  const [draftTick, setDraftTick] = useState(0)
  const [editing] = useState(() => new EditSessions(() => setDraftTick(n => n + 1)))
  useEffect(() => () => editing.dispose(), [editing])
  const [selection] = useState(() => new ContentSelectionChannel())
  const overlays = useWindowOverlays()
  // 页面结束需要插件宿主，插件宿主又调用工作区动作。只在此处接通，模块不互相读取内部状态。
  const uiRef = useRef<Pick<ReturnType<typeof useUiHost>, 'host' | 'hostForTab' | 'forgetTab'>>(undefined)
  const pageHosts = useMemo<PageHosts>(() => ({
    forPage(id) {
      if (!uiRef.current) throw new Error('窗口宿主尚未装配完成')
      return uiRef.current.hostForTab(id)
    },
    forget: id => uiRef.current?.forgetTab(id)
  }), [])

  const readHost = useCallback(() => uiRef.current?.host, [])
  const settingsWindow = useSettingsWindow({ libraryId, readHost, notify: overlays.actions.notify })
  const { open: settingsOpen, close: closeSettingsIfOpen, beforePrepare, onLegacySettings } = settingsWindow

  const workspace = useWorkspace({ core,
    libraryId,
    editing,
    draftTick,
    selection,
    hosts: pageHosts,
    beforePrepare,
    onLegacySettings,
    notify: overlays.actions.notify,
    reportSaveError: overlays.actions.reportSaveError
  })
  const { snapshot: ws, catalog, pages, closeTab, togglePanel } = workspace
  const { leaving, transitions } = workspace.lifecycle

  const navigation = workspace
  const { activate, openCollection } = navigation

  const intake = useIntake({ core, pages, notify: overlays.actions.notify })
  const ui = useUiHost({
    presets: workspace.presets,
    core,
    root,
    libraryId,
    selection,
    editing,
    pages,
    navigation,
    overlays: overlays.actions,
    intake,
    busy: () => transitions.busy,
    presentSettings: settingsWindow.present
  })
  uiRef.current = ui
  const { host, createNew } = ui

  const { display: commandDisplay, session: commandSession, open: openCommandPalette, close: closeCommandPalette, execute: executeCommand } = useCommandPalette(host, overlays.actions.notify)

  const drop = useTransferInput({ intake, pages, activate, notify: overlays.actions.notify })
  useWindowCommands({
    host,
    pages,
    navigation,
    overlays: {
      ...overlays.actions,
      preview: overlays.preview,
      modalOpen: overlays.modalOpen || !!commandSession,
      commandPaletteOpen: !!commandSession,
      openCommandPalette,
      closeCommandPalette
    },
    editing,
    transitions,
    createNew,
    receive: intake.receive,
    captureTarget: intake.captureTarget
  })

  const purged = useCallback((ids: string[]) => {
    const gone = new Set(ids)
    void (async () => {
      for (const t of pages.entries()) {
        const key = tabTypeOf(t.type)?.key?.(t.params)
        if (key !== undefined && gone.has(key)) await closeTab(t.id)
      }
    })()
    overlays.actions.forgetPurged(ids)
  }, [pages, closeTab, overlays.actions])

  const [busy, setBusy] = useState(false)
  useEffect(() => core.on('progress', p => setBusy(p.busy)), [core])
  const [resizingPanel, setResizingPanel] = useState(false)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  if (!ws) return <div className="workspace-loading" role="status">{workspace.loadError ? <><p>工作区暂未载入</p><p>{workspace.loadError}</p><button className="small" onClick={() => window.location.reload()}>重试</button></> : '正在载入工作区…'}</div>

  const activeEntry = ws.tabs.find((t) => t.id === ws.active)!
  const sizes = panelWidths(ws.panelSizes, windowWidth)
  const vaultName = portablePath(root).split('/').filter(Boolean).pop()

  return (
    <CollectionLibraryContext.Provider value={libraryId}>
    <WindowProviders host={host}>
    <ToolDragProvider detach={workspace.docking.detach}>
    <EditorDragProvider detach={workspace.editorActions.onDetach}>
    <SurfaceHost>
    <div inert={leaving} aria-busy={leaving} className={`app${ws.panels.sidebar ? '' : ' sidebar-collapsed'}${ws.panels.inspector ? '' : ' inspector-collapsed'}${resizingPanel ? ' panel-resizing' : ''}`}
      style={{ '--sidebar-size': `${sizes.sidebar}px`, '--inspector-size': `${sizes.inspector}px` } as CSSProperties}>
      <SidebarWorkspace libraryTitle={vaultName ?? '当前仓库'} onCommand={openCommandPalette}
        status={<><DevelopmentNotice onOpen={() => void host.openSettings({ section: 'development' }).catch(e => host.notify(String(e)))} />
          {unavailable.length > 0 && <button className="workspace-warning" title={unavailable.map(u => `${u.plugin}：${u.reason}`).join('\n')} aria-label="插件不可用详情" onClick={() => host.notify(unavailable.map(u => `${u.plugin}：${u.reason}`).join('；'))}>!</button>}
          {busy && <span className="workspace-busy" role="status" title="正在加工" aria-label="正在加工">•</span>}</>}
        host={host} snapshot={workspace.sidebarSnapshot!} actions={workspace.sidebarActions} hostForPage={ui.hostForTab} onLocate={activate}
        widths={{ left: sizes.sidebar, right: sizes.inspector }}
        onResizing={setResizingPanel}
        docking={workspace.docking} />
      <main className="main">
        <EditorWorkspace catalog={catalog} docking={workspace.docking} workspace={ws} host={host} drop={drop}
          startControls={!ws.panels.sidebar && <PanelToggle side="left" expanded={false} onToggle={() => togglePanel('sidebar')} />}
          endControls={!ws.panels.inspector && <PanelToggle side="right" expanded={false} onToggle={() => togglePanel('inspector')} />}
          {...navigation.editorActions}/>
      </main>
      <ContentWindows workspace={workspace} host={host} drop={drop}/>
      <EditorSurfaces workspace={ws} alive={workspace.alive} renderTab={(entry, visible) => <TabHost entry={entry} active={entry.id === ws.active} visible={visible} onActivate={activate} host={ui.hostForTab(entry.id)} callbacks={workspace.callbacksFor(entry.id)} />}/>
      <ToolViewSurfaces workspace={ws} catalog={catalog} host={host} contexts={workspace.contexts} hostForPage={ui.hostForTab} onLocate={activate} onClose={workspace.sidebarActions.closeTool}
        builtin={{
          'host.navigation': <Sidebar
            host={host}
            libraryId={libraryId}
            drop={drop?.view ? { id: drop.view, internal: drop.internal } : undefined}
            current={['collection', 'management'].includes(activeEntry.type) ? (activeEntry.params as CollectionParams) : undefined}
            activeTab={{ type: activeEntry.type, params: activeEntry.params }}
            onOpen={(params, newTab) => openCollection(params, { newTab })}
          />,
          'host.inspector': <Inspector selection={pages.focus(ws.active)} host={host} pages={pages} onLocate={activate} />
        }} />
      <ContentSelectionMenu host={host} />
      <WindowOverlays state={overlays} leaving={leaving} host={host} onPurged={purged} />
      {settingsOpen && <SettingsWindow leaving={leaving} host={host} libraryId={libraryId} onRequestClose={closeSettingsIfOpen} onLost={settingsWindow.lost} />}
      {commandSession && (
        <DisplayPortal doc={commandDisplay}><CommandPalette
          session={commandSession}
          host={host}
          onCancel={closeCommandPalette}
          onExecute={executeCommand}
        /></DisplayPortal>
      )}
    </div>
      <WindowNotices state={overlays} leaving={leaving}>
        <AdmissionFeedback reports={intake.reports} host={host} dismiss={intake.dismissReport} />
        {intake.review && <ViewImportReview key={intake.review.id} request={intake.review} finish={selected => intake.finishReview(intake.review!.id, selected)} />}
      </WindowNotices>
    </SurfaceHost>
    </EditorDragProvider>
    </ToolDragProvider>
    </WindowProviders>
    </CollectionLibraryContext.Provider>
  )
}
