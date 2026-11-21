import { t, useLanguage } from './language'
import { AuxiliarySurface, blurAuxiliaryInputs } from './auxiliary-surface'
import { StartingPreset } from './components/StartingPreset'
import { LauncherCreate } from './components/LauncherCreate'
import { LauncherAi } from './components/LauncherAi'
import { useMcpSettings } from '../../plugins/mcp/use-mcp-settings'
import type { ApplicationMcpSettings } from '../../plugins/mcp/settings'
import { defaultStartingChoice, useStartingPreset } from './components/use-starting-preset'
import { SettingGroup, SettingRow } from './components/ui-primitives'
import { portableFileName } from '../../shared/paths'
import type { CreationRecovery, LauncherFolder } from '../../shared/library-creation'

import { SettingsController } from './settings-controller'
import { applicationSettingsPages } from './application-settings-catalog'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApplicationSettings } from './components/ApplicationSettings'
import { useModalFocus } from './components/modal-focus'
import { SettingsHeader } from './components/SettingsHeader'
import { SettingsIcon, SparklesIcon, VaultIcon } from './components/icons'

const grantLabels = { read: 'launcher.readonly', organize: 'launcher.organize', admin: 'launcher.managed' } as const

function libraryGrant(settings: ApplicationMcpSettings | undefined, vault: VaultInfo) {
  if (!vault.exists || !settings?.enabled) return
  const matches = settings.libraries.filter(l => l.root === vault.path)
  // 更换目录里的仓库后可能留有旧登记。身份不明确时不展示旧授权。
  const grant = matches.find(l => l.open) ?? (matches.length === 1 ? matches[0] : undefined)
  if (!grant || grant.mode === 'off' || settings.libraries.some(l => l !== grant && l.libraryId === grant.libraryId && l.mode !== 'off')) return
  return t(grantLabels[grant.mode])
}

export function Launcher() {
  useLanguage()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const ai = useMcpSettings(window.bridge.application.service)
  const aiSettings = ai.settings
  const creation = aiSettings?.creation
  const aiDescription = creation
    ? <span className="launcher-ai-directory"><span>{aiSettings.enabled ? t('launcher.creationDir') : t('launcher.aiPaused')}</span>
        <span className="launcher-location-path" title={creation.parent}>{'\u200e' + creation.parent}</span></span>
    : aiSettings?.enabled ? t('launcher.aiReady') : t('launcher.aiIntro')
  const settingsRoot = useRef<HTMLDivElement>(null)
  useModalFocus(settingsRoot, settingsOpen)
  const [settingsService] = useState(
    () => new SettingsController(applicationSettingsPages, () => { setSettingsOpen(true); void window.bridge.auxiliary.focus('settings') }, 'application')
  )
  const snapshot = useSyncExternalStore(settingsService.subscribe, settingsService.getSnapshot)
  useEffect(() => () => settingsService.dispose(), [settingsService])
  useEffect(() => window.bridge.lifecycle.onPrepare(async reason => {
    blurAuxiliaryInputs()
    if (!await settingsService.beforeLeave({ reason })) {
      void window.bridge.auxiliary.focus('settings')
      throw new Error(settingsService.getSnapshot().blockedReason ?? t('launcher.unsaved'))
    }
  }, () => {}), [settingsService])

  const [recent, setRecent] = useState<VaultInfo[]>([])
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [error, setError] = useState<string>()
  const [space, setSpace] = useState<import('../../shared/file-spaces').SpaceInfo>()
  const [source, setSource] = useState<LauncherFolder>()
  const [turn, setTurn] = useState<{ folder: LauncherFolder; action: 'create' | 'open' | 'source' }>()
  const autoName = useRef('')
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState<'home' | 'create' | 'preset' | 'ai'>('home')
  const [choice, setChoice] = useState(defaultStartingChoice)
  const [draft, setDraft] = useState(defaultStartingChoice)
  const model = useStartingPreset(page === 'preset' ? draft : choice)
  const [recoveries, setRecoveries] = useState<CreationRecovery[]>([])
  const stage = useRef<HTMLElement>(null)
  useEffect(() => {
    const focus = stage.current?.querySelector<HTMLElement>(page === 'create' ? 'input' : 'h1')
    focus?.focus()
  }, [page])
  const browsePreset = (id?: string) => {
    setDraft(id ? { id, versions: [], layout: true } : choice)
    setPage('preset')
  }

  const openSettings = useCallback((section?: string) => {
    void settingsService
      .open(section ? { scope: 'application', section } : undefined)
      .then(ok => {
        if (!ok) setError(settingsService.getSnapshot().blockedReason ?? t('launcher.busySettings'))
      })
      .catch(e => setError(String(e)))
  }, [settingsService])

  const { refresh: refreshAi } = ai
  const settingsClosed = useCallback(() => { setSettingsOpen(false); void refreshAi() }, [refreshAi])
  const closeSettings = useCallback(async () => {
    try {
      blurAuxiliaryInputs()
      const ok = await settingsService.beforeLeave({ reason: 'close' })
      if (ok) {
        settingsClosed()
        setError(undefined)
        return true
      }
      setError(settingsService.getSnapshot().blockedReason ?? t('launcher.busySettings'))
      return false
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [settingsService, settingsClosed])

  const refresh = useCallback(() => {
    void Promise.all([window.bridge.vaults.list(), window.bridge.creation.pending()]).then(([d, pending]) => {
      setRecent(d.recent); setRecoveries(pending)
      setParent((p) => p || d.defaultParent)
    }).catch(e => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
    // 别的窗口里开关了仓库：回到这里时刷新
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  useEffect(() => window.bridge.onMenuCommand(command => { if (command === 'settings') openSettings() }), [openSettings])

  const run = async (fn: () => Promise<VaultResult>) => {
    setBusy(true)
    setError(undefined)
    try { const r = await fn(); if ('error' in r) setError(r.error) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false); refresh() }
  }

  const startFromFolder = (folder: LauncherFolder) => {
    setSource(folder); setTurn(undefined); setError(undefined)
    if (page === 'home' || !name.trim() || name === autoName.current) {
      let suggestion = portableFileName(folder.name).slice(0, 96) || t('common.library')
      if (parent === folder.parent && suggestion === folder.name) suggestion += t('launcher.nameSuffix')
      autoName.current = suggestion; setName(suggestion)
    }
    setPage('create')
  }
  const pickFolder = async (purpose: 'open' | 'source') => {
    setError(undefined); setTurn(undefined)
    try {
      const folder = await window.bridge.creation.pickFolder(purpose)
      if (!folder) return
      if (purpose === 'open' && folder.kind === 'library') return void run(() => window.bridge.vaults.open(folder.path))
      if (purpose === 'source' && folder.kind !== 'library') return startFromFolder(folder)
      setTurn({ folder, action: folder.kind === 'library' ? 'open' : folder.kind === 'empty' ? 'create' : 'source' })
    } catch (e) { setError(String(e)) }
  }
  const followTurn = () => {
    if (!turn) return
    const { action, folder } = turn
    setTurn(undefined)
    if (action === 'open') return void run(() => window.bridge.vaults.open(folder.path))
    if (action === 'source') return startFromFolder(folder)
    setSource(undefined); setParent(folder.parent); setName(folder.name); setPage('create')
  }

  const create = () => {
    const preview = model.preview
    if (name.trim() && parent.trim() && !busy && preview && !preview.issues.length) void run(() => window.bridge.creation.create({
      parent, name, spaceRoot: space?.root, spaceId: space?.id, preset: model.preset, plugins: model.preset ? undefined : [], previewRevision: preview.revision
    }, source?.token))
  }

  return (
    <div className="launcher" data-page={page}>
      <aside className="launcher-recent">
        <div className="launcher-recent-top">
          <div className="launcher-drag" />
          <div className="launcher-brand">
            <div className="launcher-brand-icon" aria-hidden="true">
              <VaultIcon size={16} />
            </div>
            <span>{t('launcher.list')}</span>
          </div>
          <div className="nav-title">{t('launcher.recent')}</div>
          <div className="launcher-recent-list">
            {recent.map((v) => {
              const badge = libraryGrant(aiSettings, v)
              return (
                <div key={v.path} className={`vault-item${v.exists ? '' : ' missing'}${v.open ? ' is-open' : ''}`}>
                  <button className="vault-open" disabled={!v.exists || busy} onClick={() => void run(() => window.bridge.vaults.open(v.path))}>
                    <span className="vault-title">
                      <span className="vault-name" title={v.name}>{v.name}</span>
                      {badge && <span className="launcher-ai-badge">{badge}</span>}
                      {v.open && <span className="muted"> {t('launcher.opened')}</span>}
                    </span>
                    {/* 路径太长时省略开头；前面加一个从左到右的标记，免得开头的 / 被排到末尾 */}
                    <span className="vault-path">{'\u200e' + (v.exists ? v.path : t('launcher.missing', { path: v.path }))}</span>
                  </button>
                  <button className="nav-x" title={t('launcher.forget')} disabled={busy} onClick={() => void window.bridge.vaults.forget(v.path).then(refresh).catch(e => setError(String(e)))}>
                    ×
                  </button>
                </div>
              )
            })}
          </div>
          {!recent.length && (
            <div className="launcher-empty-recent muted launcher-hint">
              <span>{t('launcher.empty')}</span>
              <small>{t('launcher.emptyHint')}</small>
            </div>
          )}
        </div>
        <button className="launcher-settings-entry" title={t('launcher.settingsEntry')} aria-label={t('launcher.settingsEntry')} onClick={() => openSettings()}>
          <SettingsIcon size={15} />{t('common.settings')}
        </button>
      </aside>

      <main className="launcher-main" ref={stage}>
        <div className="launcher-drag" />
        <div className="launcher-shell">
          {page !== 'home' && <nav className="launcher-back"><button disabled={busy} onClick={() => { setTurn(undefined); setError(undefined); setPage(page === 'preset' ? 'create' : 'home') }}>
            {page === 'preset' ? t('launcher.backCreate') : t('launcher.back')}
          </button></nav>}
          {error && !settingsOpen && <div role="alert" className="launcher-error">{error}{page !== 'home' && !!recoveries.length && <button className="small" onClick={() => setPage('home')}>{t('launcher.pending')}</button>}</div>}
          {turn && <div className="launcher-error" role="status">
            <span>{turn.folder.name} {turn.action === 'open' ? t('launcher.existing') : turn.action === 'create' ? t('launcher.emptyFolder') : t('launcher.sourceFolder')}</span>{' '}
            <button className="small" onClick={followTurn}>{turn.action === 'open' ? t('launcher.openThis') : turn.action === 'create' ? t('launcher.createHere') : t('launcher.fromThis')}</button>
            <button className="small" onClick={() => setTurn(undefined)}>{t('common.cancel')}</button>
          </div>}
          {page === 'home' && <>
          <header className="launcher-hero">
            <div className="launcher-logo" aria-hidden="true" />
            <h1 tabIndex={-1}>{t('common.brand')}</h1>
            <p className="muted">{t('launcher.tagline')}</p>
          </header>
          <SettingGroup className="launcher-home-actions">
            <SettingRow title={t('common.newLibrary')} description={t('launcher.newHint')}>
              <button className="small" disabled={busy} onClick={() => void pickFolder('source')}>{t('launcher.fromFolder')}</button>
              <button className="primary" disabled={busy} onClick={() => { setTurn(undefined); setSource(undefined); setPage('create') }}>{t('launcher.create')}</button>
            </SettingRow>
            <SettingRow title={t('common.openLibrary')} description={t('launcher.openHint')}>
              <button className="small" disabled={busy} onClick={() => void pickFolder('open')}>{t('common.open')}</button>
            </SettingRow>
            <SettingRow title={<span className="launcher-ai-title"><SparklesIcon size={15} />{t('launcher.ai')}</span>} description={aiDescription}>
              <button className="small" disabled={busy} onClick={() => { setPage('ai'); void refreshAi() }}>
                {creation || aiSettings?.enabled ? t('launcher.configure') : t('common.settingsMenu')}
              </button>
            </SettingRow>
          </SettingGroup>
          {!!recoveries.length && <details className="launcher-recoveries" aria-label={t('launcher.unfinished')}>
            <summary>{t('launcher.pendingCount', { count: recoveries.length })}</summary>
            {recoveries.map(job => <article key={job.id} data-creation-id={job.id}>
              <div className="launcher-recovery-head">
                <strong>{job.name}{job.title ? ' · ' + job.title : ''}</strong>
                <span className="muted">{job.root}</span>
              </div>
              {job.error && <p className="package-error">{job.error}</p>}
              <div className="launcher-space-actions">
                <button className="small primary" disabled={busy} onClick={() => void run(() => window.bridge.creation.resume(job.id))}>{t('launcher.resume')}</button>
                <button className="small" disabled={busy} onClick={() => void run(() => window.bridge.creation.openBasic(job.id))}>{t('launcher.openBasic')}</button>
                <button className="small" disabled={busy} onClick={() => void run(async () => { await window.bridge.creation.dismiss(job.id); return { ok: true } })}>{t('launcher.dismiss')}</button>
              </div>
              <small className="muted">{t('launcher.recoveryHint')}</small>
            </article>)}
          </details>}
          </>}

          {page === 'ai' && <>
            {ai.error && <div role="alert" className="launcher-error">{ai.error} <button className="small" onClick={() => void refreshAi()}>{t('launcher.reload')}</button>
              {' '}<button className="small" onClick={() => openSettings('mcp.connection')}>{t('launcher.aiSettings')}</button></div>}
            {aiSettings ? <LauncherAi settings={aiSettings} busy={ai.busy} save={ai.save} settingsOpen={settingsOpen}
              openSettings={() => openSettings('mcp.connection')} /> : !ai.error && <p role="status">{t('launcher.loadingAi')}</p>}
          </>}
          {page === 'create' && <LauncherCreate name={name} parent={parent} space={space} model={model} busy={busy}
            source={source?.path} pickSource={() => void pickFolder('source')} removeSource={() => setSource(undefined)}
            onName={v => { autoName.current = ''; setName(v) }} onParent={setParent} onSpace={setSpace} onError={setError} onBrowse={() => browsePreset()} onSelect={id => setChoice({ id, versions: [], layout: true })} onCreate={create} />}
          {page === 'preset' && <section className="launcher-preset-page" aria-label={t('launcher.choosePreset')}>
            <h1 tabIndex={-1}>{t('launcher.choosePreset')}</h1>
            <StartingPreset model={model} value={draft} disabled={busy} onChange={setDraft} onInstall={() => {
              void settingsService.open({ scope: 'application', section: 'packages' }).catch(e => setError(String(e)))
            }} />
            <footer className="launcher-create-footer">
              <span className="muted">{t('launcher.installHint')}</span>
              <button className="primary" disabled={busy || !model.preview || !!model.preview.issues.length} onClick={() => { setChoice(draft); setPage('create') }}>{t('launcher.usePreset')}</button>
            </footer>
          </section>}
        </div>
      </main>

      {settingsOpen && (
        <AuxiliarySurface kind="settings" title={t('common.applicationSettings')} onClose={closeSettings} onLost={settingsClosed}>
          <div
            className="launcher-settings settings settings-modal launcher-settings-modal settings-window-content"
            ref={settingsRoot}
            tabIndex={-1}
            role="dialog"
            aria-modal="false"
            aria-label={t('common.applicationSettings')}
            onKeyDown={e => {
              if ((e.target as Element).closest('[role="dialog"]') !== e.currentTarget) return
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                void closeSettings()
              }
            }}
          >
            <SettingsHeader title={t('common.applicationSettings')} scope={t('common.appScope')}
              backLabel={t('launcher.backLibraries')} onClose={closeSettings} />
            {error && <p role="alert" className="launcher-error">{error}</p>}
            <ApplicationSettings settings={settingsService} section={snapshot.target?.section} presetActionLabel={t('launcher.createPreset')} onInstalledPresets={ids => { if (ids.length === 1) browsePreset(ids[0]) }} onPreviewPreset={async id => {
              if (await closeSettings()) browsePreset(id)
            }} />
          </div>
        </AuxiliarySurface>
      )}
    </div>
  )
}
