import { t, useLanguage } from '../language'
import { useMemo } from 'react'
import type { UiHost } from '../plugin'
import { AuxiliarySurface } from '../auxiliary-surface'
import { useWindowOverlays, WindowNotices, WindowOverlays } from '../app/overlays'
import { SettingsContent } from './SettingsContent'

export function SettingsWindow({ host, libraryId, onRequestClose, onLost, leaving }: {
  host: UiHost; libraryId: string; leaving: boolean; onRequestClose(): Promise<boolean>; onLost(): void
}) {
  useLanguage()
  const overlays = useWindowOverlays()
  const localHost = useMemo<UiHost>(() => ({ ...host,
    showDialog: overlays.actions.showDialog, notify: overlays.actions.notify,
    preview: overlays.actions.preview, attach: overlays.actions.attach,
    exportItems: overlays.actions.exportItems, takeout: overlays.actions.takeout, purge: overlays.actions.purge
  }), [host, overlays.actions])
  return <AuxiliarySurface kind="settings" title={t('common.settings')} onClose={onRequestClose} onLost={onLost}>
    <div inert={leaving} style={{height: '100%'}}><SettingsContent host={localHost} libraryId={libraryId} onRequestClose={onRequestClose} /></div>
    <WindowOverlays leaving={leaving} state={overlays} host={localHost} onPurged={overlays.actions.forgetPurged} />
    <WindowNotices state={overlays} leaving={false}>{null}</WindowNotices>
  </AuxiliarySurface>
}
