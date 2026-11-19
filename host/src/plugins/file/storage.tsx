import { useUiEffect } from '../../plugin-api/ui/hooks'
import { useState } from 'react'
import type { UiHost } from '../../plugin-api/ui/contracts'
import type { FileStorageInfo } from '../../shared/file-storage'
import type { FileUpdatePreview } from '../../shared/file-updates'

const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

/** 侧栏与详细窗口使用同一口径；模式来自空间登记，不从 file.path 推断。 */
export function FileStorageFields({ info, refresh, busy, openSpace, onPreviewUpdate }: {
  openSpace?: () => void
  onPreviewUpdate?: () => void
  info: FileStorageInfo
  refresh?: () => void
  busy?: boolean
}) {
  const space = info.storageKind === 'space'
  const mode = info.mode === 'shared' ? '共享' : info.mode === 'private' ? '独享' : '模式未确认'
  const placement = info.spaceEmbedded === undefined ? '' : info.spaceEmbedded ? '随仓库保存' : '独立目录'
  const state = info.associationState === 'detached' ? '已解除关联'
    : info.associationState === 'pending' ? '关联待完成'
    : info.associationState === 'detaching' ? '解除待完成'
    : info.lifecycle === 'disposed' ? '原件已移到系统废纸篓'
    : info.lifecycle === 'disposing' ? '原件处置未完成'
    : info.lifecycle === 'recycled' ? '原件已回收'
    : info.state === 'available' ? '可用' : info.state === 'missing' ? '文件缺失' : '暂不可用'
  const hasUpdate = info.hasUpdate ?? (info.contentOrdinal !== undefined && info.currentOrdinal !== undefined && info.currentOrdinal !== info.contentOrdinal)
  return <>
    <dt>{space ? '文件空间' : '存储'}</dt>
    <dd className="breakable" title={info.storageRoot}>{space ? <>{info.spaceName ?? info.spaceId ?? '未确认'}{openSpace && <> · <button className="link" onClick={openSpace}>查看空间</button></>}</> : info.storageKind === 'legacy-shared' ? '旧版逐文件共享' : '旧版仓库文件'}</dd>
    {space && <><dt>管理方式</dt><dd>{[mode, placement].filter(Boolean).join(' · ')}</dd></>}
    {info.contentOrdinal !== undefined && <><dt>内容版本</dt><dd>
      本库 V{info.contentOrdinal}{hasUpdate ? ` · 空间 V${info.currentOrdinal} 待接纳` : ' · 已是当前版'}
      {hasUpdate && onPreviewUpdate && <> · <button className="link" disabled={busy} onClick={onPreviewUpdate}>预览更新…</button></>}
    </dd></>}
    <dt>文件状态</dt><dd title={info.reason}>{state}{refresh && <> · <button className="link" disabled={busy} onClick={refresh}>{busy ? '检查中…' : '刷新'}</button></>}</dd>
  </>
}

export function FileStorageSection({ id, host }: { id: string; host: UiHost }) {
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
      const preview = await host.core.previewFileUpdate(id)
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
      host.notify('已接纳空间新版，素材身份与附加数据保留')
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
      <><dt>存储</dt><dd>{busy ? '读取中…' : '读取失败'}{!busy && <> · <button className="link" onClick={() => setRevision(v => v + 1)}>重试</button></>}</dd></>
    )}
    {(error || info?.reason) && <><dt>说明</dt><dd className="breakable muted">{error || info?.reason}</dd></>}
    {updatePreview && (
      <div className="inspector-inline-update" role="group" aria-label="预览内容更新" style={{ gridColumn: '1 / -1', marginTop: 8, padding: 10, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
          <strong>本库 V{updatePreview.preview.previous.ordinal} → 空间 V{updatePreview.preview.current.ordinal}</strong>
          <span className="muted">{size(updatePreview.preview.current.size)}</span>
        </div>
        {updatePreview.preview.previous.unavailable && <p className="package-error">旧内容不可读取；接纳后保留历史失配登记。</p>}
        {/\.(png|jpe?g|webp|gif|avif)$/i.test(updatePreview.preview.current.name) && <img style={{ maxWidth: '100%', maxHeight: 180 }} src={host.url(updatePreview.preview.current.reference)} alt="空间新版预览" />}
        {updatePreview.preview.current.sample !== undefined && (
          <pre style={{ margin: '0 0 8px', maxHeight: 120, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>
            {updatePreview.preview.current.sample}
          </pre>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="small" disabled={busy} onClick={() => setUpdatePreview(undefined)}>取消</button>
          <button className="small primary" disabled={busy} onClick={() => void acceptUpdate()}>接纳新版</button>
        </div>
      </div>
    )}
  </>
}
