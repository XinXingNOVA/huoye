import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { DisplayPortal } from '../DisplayPortal'
import { displayDocument } from '../display-windows'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { KeyHandler, UiHost } from '../plugin'
import { Preview } from '../components/Preview'
import { QuickAttach } from '../components/QuickAttach'
import { ExportDialog } from '../components/ExportDialog'
import { TakeoutDialog } from '../components/TakeoutDialog'
import { PurgeDialog } from '../components/PurgeDialog'

/** 窗口内临时画面。确认收录与批次结果由 intake 自己管理。 */
export function useWindowOverlays() {
  const [display, setDisplay] = useState<Document>()
  const [noticeDisplay, setNoticeDisplay] = useState<Document>()
  const [dialogDisplay, setDialogDisplay] = useState<Document>()
  const [preview, setPreview] = useState<string>()
  const [attach, setAttach] = useState<string[]>()
  const [exporting, setExporting] = useState<{ ids: string[]; name: string }>()
  const [purging, setPurging] = useState<string[]>()
  /** 插件弹出的对话框（例如改名）。 */
  const [dialog, setDialog] = useState<{ render(close: () => void): ReactNode }>()
  const [takingOut, setTakingOut] = useState<{ ids: string[]; name: string }>()
  const [toast, setToast] = useState<string>()
  const overlayKeys = useRef<KeyHandler | null>(null)
  const registerOverlayKeys = useCallback((h: KeyHandler | null) => { overlayKeys.current = h }, [])
  const showToast = useCallback((text: string, doc = displayDocument()) => {
    setNoticeDisplay(doc); setToast(text)
    setTimeout(() => setToast((t) => (t === text ? undefined : t)), 2200)
  }, [])

  const actions = useMemo(() => ({
    preview: (id?: string) => { setPreview(id); setDisplay(displayDocument()) },
    closePreview: () => setPreview(undefined),
    previewKeys: () => overlayKeys.current,
    attach: (ids: string[]) => { setAttach(ids); setDisplay(displayDocument()) },
    exportItems: (ids: string[], name: string) => { setExporting({ ids, name }); setDisplay(displayDocument()) },
    takeout: (ids: string[], name: string) => { setTakingOut({ ids, name }); setDisplay(displayDocument()) },
    purge: (ids: string[]) => { setPurging(ids); setDisplay(displayDocument()) },
    showDialog: (render: (close: () => void) => ReactNode) => { setDialog({ render }); setDialogDisplay(displayDocument()) },
    notify: showToast,
    reportSaveError: (text: string) => setToast(text),
    forgetPurged: (ids: string[]) => { const gone = new Set(ids); setPreview(p => p && gone.has(p) ? undefined : p) }
  }), [showToast])
  return { display, dialogDisplay, noticeDisplay, preview, attach, exporting, takingOut, purging, dialog, toast, actions, registerOverlayKeys,
    modalOpen: !!(attach || exporting || purging || dialog || takingOut),
    closeAttach: () => setAttach(undefined), closeExport: () => setExporting(undefined),
    closeTakeout: () => setTakingOut(undefined), closePurge: () => setPurging(undefined), closeDialog: () => setDialog(undefined) }
}
export type WindowOverlayActions = ReturnType<typeof useWindowOverlays>['actions']

/** 保持原来的画面层次：业务浮层随工作区 inert，插件对话框和状态提示仍在其外部。 */
export function WindowOverlays({ state, host, onPurged, leaving }: { leaving: boolean; state: ReturnType<typeof useWindowOverlays>; host: UiHost; onPurged(ids: string[]): void }) {
  const { preview, attach, exporting, takingOut, purging } = state
  return <DisplayPortal doc={state.display}><div inert={leaving}>
    {preview && <Preview id={preview} host={host} onClose={state.actions.closePreview} registerKeys={state.registerOverlayKeys} />}
    {attach && <QuickAttach ids={attach} host={host} onClose={state.closeAttach} />}
    {exporting && <ExportDialog ids={exporting.ids} name={exporting.name} host={host} onClose={state.closeExport} />}
    {takingOut && <TakeoutDialog ids={takingOut.ids} name={takingOut.name} host={host} onClose={state.closeTakeout} />}
    {purging && <PurgeDialog ids={purging} host={host} onClose={state.closePurge} onDone={onPurged} />}
  </div></DisplayPortal>
}

export function WindowNotices({ state, leaving, children }: { state: ReturnType<typeof useWindowOverlays>; leaving: boolean; children: ReactNode }) {
  useUiLocale()
  const { dialog, toast, closeDialog } = state
  return <>
    {dialog && <DisplayPortal doc={state.dialogDisplay}><div className="qa-backdrop" onMouseDown={e => e.target === e.currentTarget && closeDialog()}>
      <div className="quick-attach export-dialog" onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), closeDialog())}>
        {dialog.render(closeDialog)}
      </div>
    </div></DisplayPortal>}
    {leaving && !dialog && <div className="toast" role="status">{uiText("正在保存页面状态…")}</div>}
    {children}
    {toast && !leaving && <DisplayPortal doc={state.noticeDisplay}><div className="toast">{toast}</div></DisplayPortal>}
  </>
}
