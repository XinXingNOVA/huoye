import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useState } from 'react'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { isDirectoryFile } from '../../../shared/file-location'
import type { FileStorageInfo } from '../../../shared/file-storage'
import { FileStorageDialog } from './FileStorageDialog'
import { useEntity } from '../entity-cache'
import type { KeyHandler, UiHost } from '../plugin'
import { previewFor, titleFor } from '../ui-registry'
import { DataDetails } from './DataDetails'

export function Preview({
  id,
  host,
  onClose,
  registerKeys
}: {
  id: string
  host: UiHost
  onClose(): void
  registerKeys(h: KeyHandler | null): void
}) {
  useUiLocale()
  const view = useEntity(id)
  const reference = view?.blocks.file?.data.path
  const [storage, setStorage] = useState<{ id: string; info: FileStorageInfo }>()
  useUiEffect(display => {
    if (!isDirectoryFile(reference)) return
    let alive = true, request = 0
    const check = () => {
      const current = ++request
      void host.core.fileStorageInfo(id).then(info => {
        if (alive && current === request) setStorage({ id, info })
      }).catch(e => {
        if (alive && current === request) setStorage({ id, info: { storageKind: 'directory', state: 'unavailable', shared: false, reason: String(e) } })
      })
    }
    check()
    display.onWindow('focus', check)
    const off = host.core.on('changed', event => { if (event.ids.includes(id)) check() })
    return () => { alive = false; off() }
  }, [host, id, reference])
  if (!view) return null
  const info = isDirectoryFile(reference) && storage?.id === id ? storage.info : undefined
  const preview = previewFor(view)
  return (
    <div className="preview" onMouseDown={onClose}>
      <div className={`preview-body${preview ? '' : ' preview-data'}`}>
        {isDirectoryFile(reference) && !info ? <p role="status">{uiText("正在读取原件…")}</p> : info && info.state !== 'available' ? <div className="empty-card" onMouseDown={e => e.stopPropagation()}>
          <p>{info.reason ?? uiText("原件暂不可用")}</p>
          <button className="small" onClick={() => host.showDialog(close => <FileStorageDialog id={id} host={host} close={close}
            previewOnOpen={info.hasUpdate || info.needsVerification} onAccepted={close}/>)}>
            {info.needsVerification ? uiText("核对并预览新版…") : info.hasUpdate ? uiText("预览新版…") : uiText("查看文件存储…")}
          </button>
        </div> : preview ? (
          <preview.Component view={view} host={host} registerKeys={registerKeys} />
        ) : (
          <div className="data-preview-scroll" onMouseDown={e => e.stopPropagation()}><DataDetails view={view} host={host} /></div>
        )}
      </div>
      <div className="preview-title">{titleFor(view)}</div>
    </div>
  )
}
