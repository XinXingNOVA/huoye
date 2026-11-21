import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import type { FileStorageInfo } from '../../../shared/file-storage'
import type { FileUpdatePreview } from '../../../shared/file-updates'
import { FileStorageFields } from '../../../plugins/file/storage'
import { UpdateComparison } from '../../../plugins/file/UpdateComparison'

import { canOpenCopy } from '../../../shared/open-copy'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export function FileStorageDialog({ id, host, close, previewOnOpen, onAccepted }: { id: string; host: UiHost; previewOnOpen?: boolean; onAccepted?(): void; close(): void }) {
  useUiLocale()
  const copyRetry = useRef<{ target: string; id: string } | undefined>(undefined)
  const [info, setInfo] = useState<FileStorageInfo>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [targets, setTargets] = useState<{ spaceId: string; name: string }[]>([]), [target, setTarget] = useState('')
  const [update, setUpdate] = useState<{ preview: FileUpdatePreview; requestId: string }>()

  useEffect(() => {
    let active = true
    void host.core.fileStorageInfo(id).then(async value => {
      if (!active) return
      setInfo(value)
      if (previewOnOpen) {
        setBusy(true)
        const preview = value.needsVerification ? await host.core.recheckFileUpdate(id) : await host.core.previewFileUpdate(id)
        if (!active) return
        if (preview.current.id !== preview.previous.id) setUpdate({ preview, requestId: crypto.randomUUID() })
        else {
          setNotice(uiText("已核对，文件内容未变"))
          const refreshed = await host.core.fileStorageInfo(id)
          if (active) setInfo(refreshed)
        }
      }
    }).catch(e => { if (active) setError(message(e)) }).finally(() => { if (active) setBusy(false) })
    void host.core.fileEditCapabilities(id).then(c => { if (active) { setTargets(c.copyTargets); setTarget(c.copyTargets[0]?.spaceId ?? '') } }).catch(() => {})
    return () => { active = false }
  }, [id, host, previewOnOpen])

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await action()
      const [next, caps] = await Promise.all([host.core.fileStorageInfo(id), host.core.fileEditCapabilities(id)])
      setInfo(next); setTargets(caps.copyTargets)
      setTarget(selected => caps.copyTargets.some(s => s.spaceId === selected) ? selected : caps.copyTargets[0]?.spaceId ?? '')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  const openUpdatePreview = () => void run(async () => {
    const preview = info?.needsVerification ? await host.core.recheckFileUpdate(id) : await host.core.previewFileUpdate(id)
    if (preview.current.id === preview.previous.id) { setNotice(uiText("已核对，文件内容未变")); setUpdate(undefined); return }
    setUpdate({ preview, requestId: crypto.randomUUID() })
  })

  return <div className="file-storage-dialog">
    <div className="export-title">{uiText("文件存储")}</div>
    {info && <>
      <div className="storage-info-card">
        <dl className="props">
          <FileStorageFields
            info={info}
            busy={busy}
            openSpace={info.spaceId ? () => { close(); host.openTab('file-spaces', { spaceId: info.spaceId }) } : undefined}
            onPreviewUpdate={openUpdatePreview}
          />
          {info.fileId && <><dt>{uiText("文件身份")}</dt><dd className="breakable storage-mono">{info.fileId}</dd></>}
          {info.storageRoot && <><dt>{uiText("存储目录")}</dt><dd className="breakable storage-mono">{info.storageRoot}</dd></>}
          {info.path && <><dt>{uiText("实际位置")}</dt><dd className="breakable storage-mono">{info.path}</dd></>}
        </dl>
      </div>
      {info.reason && <p className="export-failed">{info.reason}</p>}
    </>}

    {update && (
      <div className="space-confirm" role="group" aria-label={uiText("预览内容更新")} style={{ marginTop: 12 }}>
        <UpdateComparison preview={update.preview} host={host}/>
        <div className="space-actions">
          <button className="small" disabled={busy} onClick={() => setUpdate(undefined)}>{uiText("暂不更新")}</button>
          <button className="small primary" disabled={busy || update.preview.previous.id === update.preview.current.id} onClick={() => void run(async () => {
            const p = update.preview
            await host.core.acceptFileUpdate({ id: p.id, expectedPath: p.expectedPath, contentVersion: p.current.id, revision: p.revision, requestId: update.requestId })
            setUpdate(undefined)
            setNotice(uiText("本仓库已接纳新版。"))
            onAccepted?.()
          })}>{uiText("接纳到本仓库")}</button>
        </div>
      </div>
    )}

    {error && <div className="export-failed" role="alert">{error}</div>}
    {notice && <p role="status" className="muted" style={{ marginTop: 8 }}>{notice}</p>}
    {info && <div className="storage-edit-bar">
      <span className="storage-edit-label muted">{info.storageKind === 'directory' ? uiText("原地文件") : uiText("原件与工作副本")}</span>
      <div className="space-actions">
        {info.storageKind === 'directory' ? <button className="small" disabled={busy || info.state !== 'available' || !canOpenCopy(info.path)} onClick={() => void run(() => window.bridge.files.openOriginal(id))}>{uiText("在外部应用中打开原件")}</button> : <>
        <button className="small" onClick={() => host.editFile(id)}>{uiText("编辑文件")}</button>
        <button className="small" onClick={() => host.editFile(id, { intent: 'choose-editor' })}>{uiText("选择编辑器…")}</button>
        <button className="small" onClick={() => host.editFile(id, { intent: 'replace' })}>{uiText("选择替换文件…")}</button></>}
      </div>
    </div>}
    {info?.storageKind === 'directory' && <p className="muted">{uiText("转为托管副本后，本库使用所选空间里的副本，源目录保留原件。")}</p>}
    <div className="export-actions">
      <button className="small" disabled={busy} onClick={() => void run(async () => {})}>{uiText("刷新状态")}</button>
      {targets.length > 0 && <><select aria-label={uiText("副本保存空间")} value={target} disabled={busy} onChange={e => setTarget(e.target.value)}>{targets.map(s => <option key={s.spaceId} value={s.spaceId}>{s.name}</option>)}</select><button className="small primary" disabled={busy || !!update || !target || info?.state !== 'available'} onClick={() => void run(async () => {
        if (copyRetry.current?.target !== target) copyRetry.current = { target, id: crypto.randomUUID() }
        const result = await host.core.makeFileIndependent(id, target, copyRetry.current.id)
        if (result && result.library.state !== 'accepted') throw new Error(result.library.error)
        copyRetry.current = undefined
      })}>{info?.storageKind === 'directory' ? uiText("转为托管副本") : uiText("转为独立副本")}</button></>}
      {(info?.shared || info?.storageKind === 'directory' && info.state === 'available') && !targets.length && <p className="muted">{uiText("请先创建并关联一个独享空间，作为副本目标。")}</p>}
      <button className="small" disabled={busy} onClick={close}>{uiText("完成")}</button>
    </div>
  </div>
}
