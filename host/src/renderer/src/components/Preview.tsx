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
  const view = useEntity(id)
  if (!view) return null
  const preview = previewFor(view)
  return (
    <div className="preview" onMouseDown={onClose}>
      <div className={`preview-body${preview ? '' : ' preview-data'}`}>
        {preview ? (
          <preview.Component view={view} host={host} registerKeys={registerKeys} />
        ) : (
          <div className="data-preview-scroll" onMouseDown={e => e.stopPropagation()}><DataDetails view={view} host={host} /></div>
        )}
      </div>
      <div className="preview-title">{titleFor(view)}</div>
    </div>
  )
}
