import { t, useLanguage } from '../language'
import { CloseIcon } from './icons'

export function SettingsHeader({ title, scope, backLabel, onClose }: {
  title: string; scope: string; backLabel?: string; onClose(): void
}) {
  useLanguage()
  return (
    <header className="settings-modal-header">
      <h1 title={title}>{title}</h1>
      <span className="settings-scope-pill" title={scope}>{scope}</span>
      <div className="settings-modal-actions">
        {backLabel ? <button type="button" className="small" onClick={onClose}>{backLabel}</button>
          : <kbd className="command-kbd">Esc</kbd>}
        <button type="button" className="settings-close-btn" aria-label={t('common.closeSettings')}
          title={t('common.closeHint')} onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </div>
    </header>
  )
}
