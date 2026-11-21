import { t, useLanguage } from '../language'
import type { SpaceInfo } from '../../../shared/file-spaces'
import type { StartingPresetModel } from './use-starting-preset'
import { SettingGroup, SettingRow } from './ui-primitives'
import { isEnter } from '../widgets'

export function LauncherCreate({ name, parent, space, source, pickSource, removeSource, model, busy, onName, onParent, onSpace, onBrowse, onSelect, onCreate, onError }: {
  source?: string; pickSource(): void; removeSource(): void
  name: string; parent: string; space?: SpaceInfo; model: StartingPresetModel; busy: boolean
  onName(value: string): void; onParent(value: string): void; onSpace(value?: SpaceInfo): void
  onSelect(id: string): void; onBrowse(): void; onCreate(): void; onError(error: string): void
}) {
  useLanguage()
  const path = parent.replace(/[\\/]$/, '') + (parent.includes('\\') ? '\\' : '/') + name.trim()
  const preview = model.preview
  const starters = model.presets.filter(p => p.source?.kind === 'suite' && p.source.bundled)
  const choices = [...starters, { id: '', title: t('create.blank') }]
  const selected = model.selected
  if (selected && !choices.some(p => p.id === selected.id)) choices.push(selected)
  return <section className="launcher-create launcher-primary-card" aria-label={t('common.newLibrary')}>
    <header><h1 tabIndex={-1}>{t('common.newLibrary')}</h1><p className="muted">{t('create.intro')}</p></header>
    <SettingGroup className="launcher-card">
      <SettingRow title={<label htmlFor="launcher-name">{t('create.name')}</label>}>
        <input id="launcher-name" className="field-text" autoFocus placeholder={t('create.example')} value={name} disabled={busy}
          onChange={e => onName(e.target.value)} onKeyDown={e => { if (isEnter(e)) onCreate() }} />
      </SettingRow>
      <SettingRow title={t('create.location')} description={<div className="launcher-location" role="status">
        <span>{name.trim() ? t('create.target') : t('create.parent')}</span>
        <span className="launcher-location-path" title={name.trim() ? path : parent}>
          {parent ? '\u200e' + (name.trim() ? path : parent) : t('create.loadingPath')}
        </span>
      </div>}>
        <button className="small" disabled={busy} onClick={async () => {
          try { const next = await window.bridge.vaults.pick('parent'); if (next) onParent(next) }
          catch (e) { onError(String(e)) }
        }}>{t('create.chooseLocation')}</button>
      </SettingRow>
      <SettingRow title={t('create.source')} description={source ? <span className="launcher-location-path" title={source}>{source} {t('create.inPlace')}</span> : t('create.hint')}>
        <button className="small" disabled={busy} onClick={pickSource}>{source ? t('create.replace') : t('common.link')}</button>
        {source && <button className="small" disabled={busy} onClick={removeSource}>{t('common.remove')}</button>}
      </SettingRow>
      <details><summary>{t('create.advanced')}</summary><SettingRow title={t('create.destination')} description={space ? `${space.name} · ${space.mode === 'shared' ? t('create.shared') : t('create.private')}` : t('create.defaultSpace')}>
        <button className="small" disabled={busy} onClick={async () => {
          try { const next = await window.bridge.spaces.pick(); if (next) onSpace(next) }
          catch (e) { onError(String(e)) }
        }}>{t('create.chooseSpace')}</button>
        {space && <button className="small" disabled={busy} onClick={() => onSpace(undefined)}>{t('create.reset')}</button>}
      </SettingRow></details>
      <SettingRow title={t('create.preset')} description={<>
        <div className="launcher-starters" role="group" aria-label={t('create.preset')}>
          {choices.map(p => <button type="button" key={p.id} aria-pressed={(model.selected?.id ?? '') === p.id}
            disabled={busy} onClick={() => onSelect(p.id)}>{p.title}</button>)}
        </div>
        {preview ? model.selected?.description || (model.selected ? t('create.extensions', { count: preview.selection.external.length }) : t('create.blankHint'))
          : model.error || t('create.checking')}
      </>}>
        <button className="small" disabled={busy} onClick={onBrowse}>{t('create.more')}</button>
      </SettingRow>
    </SettingGroup>
    {model.error && <p role="alert" className="package-error">{model.error}</p>}
    {!!preview?.issues.length && <div role="alert" className="launcher-error">{preview.issues.map(i => <p key={i}>{i}</p>)}<button className="small" disabled={busy} onClick={onBrowse}>{t('create.inspect')}</button></div>}
    {!!preview?.warnings.length && <details className="muted"><summary>{t('create.notices', { count: preview.warnings.length })}</summary>{preview.warnings.map(w => <p key={w}>{w}</p>)}</details>}
    <footer className="launcher-create-footer">
      <span className="muted">{t('create.layoutHint')}</span>
      <button className="primary launcher-create-btn" disabled={!name.trim() || !parent.trim() || busy || !preview || !!preview.issues.length} onClick={onCreate}>
        {busy ? t('create.preparing') : t('create.finish')}
      </button>
    </footer>
  </section>
}
