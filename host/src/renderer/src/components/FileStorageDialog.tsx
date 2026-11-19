import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import type { FileStorageInfo } from '../../../shared/file-storage'
import type { FileUpdatePreview } from '../../../shared/file-updates'
import { FileStorageFields } from '../../../plugins/file/storage'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)
const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

export function FileStorageDialog({ id, host, close }: { id: string; host: UiHost; close(): void }) {
  const copyRetry = useRef<{ target: string; id: string } | undefined>(undefined)
  const [info, setInfo] = useState<FileStorageInfo>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [targets, setTargets] = useState<{ spaceId: string; name: string }[]>([]), [target, setTarget] = useState('')
  const [update, setUpdate] = useState<{ preview: FileUpdatePreview; requestId: string }>()

  useEffect(() => {
    let active = true
    host.core.fileStorageInfo(id).then(value => { if (active) setInfo(value) }).catch(e => { if (active) setError(message(e)) })
    void host.core.fileEditCapabilities(id).then(c => { if (active) { setTargets(c.copyTargets); setTarget(c.copyTargets[0]?.spaceId ?? '') } }).catch(() => {})
    return () => { active = false }
  }, [id, host])

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action(); setInfo(await host.core.fileStorageInfo(id)) } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  const openUpdatePreview = () => void run(async () => {
    const preview = await host.core.previewFileUpdate(id)
    setUpdate({ preview, requestId: crypto.randomUUID() })
  })

  return <div className="file-storage-dialog">
    <div className="export-title">文件存储</div>
    {info && <>
      <div className="storage-info-card">
        <dl className="props">
          <FileStorageFields
            info={info}
            busy={busy}
            openSpace={info.spaceId ? () => { close(); host.openTab('file-spaces', { spaceId: info.spaceId }) } : undefined}
            onPreviewUpdate={openUpdatePreview}
          />
          {info.fileId && <><dt>文件身份</dt><dd className="breakable storage-mono">{info.fileId}</dd></>}
          {info.storageRoot && <><dt>存储目录</dt><dd className="breakable storage-mono">{info.storageRoot}</dd></>}
          {info.path && <><dt>实际位置</dt><dd className="breakable storage-mono">{info.path}</dd></>}
        </dl>
      </div>
      {info.reason && <p className="export-failed">{info.reason}</p>}
    </>}

    {update && (
      <div className="space-confirm" role="group" aria-label="预览内容更新" style={{ marginTop: 12 }}>
        <p><strong>本库 V{update.preview.previous.ordinal} → 空间 V{update.preview.current.ordinal}</strong>（{size(update.preview.current.size)}）</p>
        {update.preview.previous.unavailable && <p className="export-failed">旧内容不可读取；接纳后保留历史失配登记。</p>}
        {/\.(png|jpe?g|webp|gif|avif)$/i.test(update.preview.current.name) && <img style={{ maxWidth: '100%', maxHeight: 180 }} src={host.url(update.preview.current.reference)} alt="空间新版预览" />}
        {update.preview.current.sample !== undefined && <pre style={{ maxHeight: 140, overflow: 'auto', fontSize: 12 }}>{update.preview.current.sample}</pre>}
        <div className="space-actions">
          <button className="small" disabled={busy} onClick={() => setUpdate(undefined)}>暂不更新</button>
          <button className="small primary" disabled={busy} onClick={() => void run(async () => {
            const p = update.preview
            await host.core.acceptFileUpdate({ id: p.id, expectedPath: p.expectedPath, contentVersion: p.current.id, revision: p.revision, requestId: update.requestId })
            setUpdate(undefined)
            setNotice('本仓库已接纳新版。')
          })}>接纳到本仓库</button>
        </div>
      </div>
    )}

    {error && <div className="export-failed" role="alert">{error}</div>}
    {notice && <p role="status" className="muted" style={{ marginTop: 8 }}>{notice}</p>}
    <div className="storage-edit-bar">
      <span className="storage-edit-label muted">原件与工作副本</span>
      <div className="space-actions">
        <button className="small" onClick={() => host.editFile(id)}>编辑文件</button>
        <button className="small" onClick={() => host.editFile(id, { intent: 'choose-editor' })}>选择编辑器…</button>
        <button className="small" onClick={() => host.editFile(id, { intent: 'replace' })}>选择替换文件…</button>
      </div>
    </div>
    <div className="export-actions">
      <button className="small" disabled={busy} onClick={() => void run(async () => {})}>刷新状态</button>
      {targets.length > 0 && <><select aria-label="副本保存空间" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}>{targets.map(s => <option key={s.spaceId} value={s.spaceId}>{s.name}</option>)}</select><button className="small primary" disabled={busy || !!update || !target || info?.state !== 'available'} onClick={() => void run(async () => {
        if (copyRetry.current?.target !== target) copyRetry.current = { target, id: crypto.randomUUID() }
        const result = await host.core.makeFileIndependent(id, target, copyRetry.current.id)
        if (result && result.library.state !== 'accepted') throw new Error(result.library.error)
        copyRetry.current = undefined
      })}>转为独立副本</button></>}
      {info?.shared && !targets.length && <p className="muted">请先创建并关联一个独享空间，作为副本目标。</p>}
      <button className="small" disabled={busy} onClick={close}>完成</button>
    </div>
  </div>
}
