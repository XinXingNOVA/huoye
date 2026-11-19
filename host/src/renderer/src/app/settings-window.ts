import { blurAuxiliaryInputs } from '../auxiliary-surface'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import { rememberSettingsForReload, takeSettingsAfterReload } from '../settings-recovery'

interface Options { libraryId: string; readHost(): UiHost | undefined; notify: UiHost['notify'] }
/** 附属窗口可见性与所属会话退出衔接；表单及配置仍由设置服务和各页面拥有。 */
export function useSettingsWindow({ libraryId, readHost, notify }: Options) {
  const [open, setSettingsOpen] = useState(false)
  const settingsOpenRef = useRef(open)
  settingsOpenRef.current = open
  const settingsClosingRef = useRef(false)
  const beforePrepare = useCallback(async (reason: 'reload' | 'shutdown', signal: AbortSignal) => {
    const h = readHost()
    if (!h) return
    blurAuxiliaryInputs()
    const allowed = await h.settings.beforeLeave({ reason }, signal)
    if (!allowed) {
      void window.bridge.auxiliary.focus('settings')
      throw new Error(h.settings.getSnapshot().blockedReason ?? '请先处理未保存的设置')
    }
    if (reason === 'reload' && settingsOpenRef.current && h.settings.getSnapshot().target) rememberSettingsForReload(libraryId, h.settings.getSnapshot().target!)
  }, [readHost, libraryId])

  const onLegacySettings = useCallback((target: { scope?: 'application' | 'library'; section?: string }) => {
    void readHost()?.openSettings(target).catch(e => notify(String(e)))
  }, [readHost, notify])

  const closeSettingsIfOpen = useCallback(async () => {
    if (!settingsOpenRef.current) return true
    if (settingsClosingRef.current) return false
    const h = readHost()
    if (!h) return true
    settingsClosingRef.current = true
    try {
      blurAuxiliaryInputs()
      const ok = await h.settings.beforeLeave({ reason: 'close' })
      if (ok) {
        settingsOpenRef.current = false
        takeSettingsAfterReload(libraryId)
        setSettingsOpen(false)
        return true
      }
      notify(h.settings.getSnapshot().blockedReason ?? '请先处理未保存的设置')
      return false
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      settingsClosingRef.current = false
    }
  }, [readHost, notify, libraryId])
  const isOpen = useCallback(() => settingsOpenRef.current, [])

  const lost = useCallback(() => { settingsOpenRef.current = false; setSettingsOpen(false) }, [])
  const present = useCallback(() => {
    void window.bridge.auxiliary.focus('settings')
    settingsClosingRef.current = false
    settingsOpenRef.current = true
    setSettingsOpen(true)
  }, [])
  useEffect(() => {
    const target = takeSettingsAfterReload(libraryId)
    if (target) void readHost()?.openSettings(target).catch(e => notify(String(e)))
  }, [libraryId, readHost, notify])
  return useMemo(() => ({ open, isOpen, present, lost, close: closeSettingsIfOpen, beforePrepare, onLegacySettings }), [open, isOpen, present, lost, closeSettingsIfOpen, beforePrepare, onLegacySettings])
}
