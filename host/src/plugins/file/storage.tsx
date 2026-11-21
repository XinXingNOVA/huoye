import { translator } from '../../shared/i18n'
import { useLocale } from '../../plugin-api/ui/locale'
import { useUiEffect } from '../../plugin-api/ui/hooks'
import { useState } from 'react'
import type { UiHost } from '../../plugin-api/ui/contracts'
import type { FileStorageInfo } from '../../shared/file-storage'
import type { FileUpdatePreview } from '../../shared/file-updates'
import { UpdateComparison } from './UpdateComparison'

/** 侧栏与详细窗口使用同一口径；模式来自空间登记，不从 file.path 推断。 */
export function FileStorageFields({ info, refresh, busy, openSpace, onPreviewUpdate }: {
  openSpace?: () => void
  onPreviewUpdate?: () => void
  info: FileStorageInfo
  refresh?: () => void
  busy?: boolean
}) {
  const t = translator(useLocale())
  const space = info.storageKind === 'space' || info.storageKind === 'directory'
  const mode = info.storageKind === 'directory' ? t('detail.directory') : info.mode === 'shared' ? t('detail.shared') : info.mode === 'private' ? t('detail.private') : t('detail.unconfirmedMode')
  const placement = info.spaceEmbedded === undefined ? '' : info.spaceEmbedded ? t('detail.embedded') : t('detail.separate')
  const state = info.associationState === 'detached' ? t('detail.detached')
    : info.associationState === 'pending' ? t('detail.pending')
    : info.associationState === 'detaching' ? t('detail.detaching')
    : info.lifecycle === 'disposed' ? t('detail.disposed')
    : info.lifecycle === 'disposing' ? t('detail.disposing')
    : info.lifecycle === 'recycled' ? t('detail.recycled')
    : info.state === 'available' ? t('detail.available') : info.state === 'missing' ? t('detail.missing') : t('detail.unavailable')
  const hasUpdate = info.hasUpdate ?? (info.contentOrdinal !== undefined && info.currentOrdinal !== undefined && info.currentOrdinal !== info.contentOrdinal)
  return <>
    <dt>{space ? t('detail.space') : t('detail.storage')}</dt>
    <dd className="breakable" title={info.storageRoot}>{space ? <>{info.spaceName ?? info.spaceId ?? t('detail.unknown')}{openSpace && <> · <button className="link" onClick={openSpace}>{t('detail.viewSpace')}</button></>}</> : info.storageKind === 'legacy-shared' ? t('detail.oldShared') : t('detail.oldLibrary')}</dd>
    {space && <><dt>{t('detail.management')}</dt><dd>{[mode, placement].filter(Boolean).join(' · ')}</dd></>}
    {(info.contentOrdinal !== undefined || info.currentOrdinal !== undefined) && <><dt>{t('detail.version')}</dt><dd>
      {info.contentOrdinal !== undefined ? t('detail.versionId', { version: `V${info.contentOrdinal}` }) : t('detail.versionId', { version: info.contentVersion?.slice(0, 8) ?? '—' })}{hasUpdate ? t('detail.versionNew', { version: info.currentOrdinal ?? '—' }) : t('detail.upToDate')}
      {hasUpdate && onPreviewUpdate && <> · <button className="link" disabled={busy} onClick={onPreviewUpdate}>{t('detail.preview')}</button></>}
    </dd></>}
    {info.needsVerification && onPreviewUpdate && <><dt>{t('detail.changed')}</dt><dd><button className="link" disabled={busy} onClick={onPreviewUpdate}>{t('detail.verify')}</button></dd></>}
    <dt>{t('detail.status')}</dt><dd title={info.reason}>{state}{refresh && <> · <button className="link" disabled={busy} onClick={refresh}>{busy ? t('detail.checking') : t('detail.refresh')}</button></>}</dd>
  </>
}

export function FileStorageSection({ id, host }: { id: string; host: UiHost }) {
  const t = translator(useLocale())
  const [info, setInfo] = useState<FileStorageInfo>(), [error, setError] = useState(''), [busy, setBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const [updatePreview, setUpdatePreview] = useState<{ preview: FileUpdatePreview; requestId: string }>()
  useUiEffect(display => {
    let alive = true, request = 0
    const load = async () => {
      const current = ++request
      setBusy(true)
      try { const value = await host.core.fileStorageInfo(id); if (alive && current === request) { setInfo(value); setError('') } }
      catch (e) { if (alive && current === request) { setInfo(undefined); setError(e instanceof Error ? e.message : String(e)) } }
      finally { if (alive && current === request) setBusy(false) }
    }
    void load()
    const focus = () => { void load() }
    const off = host.core.on('changed', ({ ids }) => { if (ids.includes(id)) void load() })
    display.onWindow('focus', focus)
    return () => { alive = false; off() }
  }, [id, host, revision])

  const openUpdatePreview = async () => {
    setBusy(true); setError('')
    try {
      const preview = info?.needsVerification ? await host.core.recheckFileUpdate(id) : await host.core.previewFileUpdate(id)
      if (preview.current.id === preview.previous.id) { setRevision(v => v + 1); host.notify(t('detail.verified')); return }
      setUpdatePreview({ preview, requestId: crypto.randomUUID() })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const acceptUpdate = async () => {
    if (!updatePreview) return
    setBusy(true); setError('')
    try {
      const p = updatePreview.preview
      await host.core.acceptFileUpdate({ id: p.id, expectedPath: p.expectedPath, contentVersion: p.current.id, revision: p.revision, requestId: updatePreview.requestId })
      setUpdatePreview(undefined)
      setRevision(v => v + 1)
      host.notify(t('detail.accepted'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return <>
    {info ? (
      <FileStorageFields
        info={info}
        busy={busy}
        openSpace={info.spaceId ? () => host.openTab('file-spaces', { spaceId: info.spaceId }) : undefined}
        onPreviewUpdate={openUpdatePreview}
        refresh={() => setRevision(v => v + 1)}
      />
    ) : (
      <><dt>{t('detail.storage')}</dt><dd>{busy ? t('detail.loading') : t('detail.failed')}{!busy && <> · <button className="link" onClick={() => setRevision(v => v + 1)}>{t('detail.retry')}</button></>}</dd></>
    )}
    {(error || info?.reason) && <><dt>{t('detail.details')}</dt><dd className="breakable muted">{error || info?.reason}</dd></>}
    {updatePreview && (
      <div className="inspector-inline-update" role="group" aria-label={t('detail.compare')} style={{ gridColumn: '1 / -1', marginTop: 8, padding: 10, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel-2)' }}>
        <UpdateComparison preview={updatePreview.preview} host={host}/>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="small" disabled={busy} onClick={() => setUpdatePreview(undefined)}>{t('detail.cancel')}</button>
          <button className="small primary" disabled={busy || updatePreview.preview.previous.id === updatePreview.preview.current.id} onClick={() => void acceptUpdate()}>{t('detail.accept')}</button>
        </div>
      </div>
    )}
  </>
}
