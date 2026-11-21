import { uiText } from '../../../shared/i18n/interface-display'
import { t, useLanguage } from '../language'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useModalFocus } from './modal-focus'
import { PluginPresets } from './PluginPresets'
import type { PluginSelection, PluginSelectionSnapshot, PresetArrangement } from '../../../shared/plugin-presets'
import { ImportSettingsPanel } from './ImportSettings'
import type { PluginState } from '../../../shared/rpc'
import type { UiHost } from '../plugin'
import { settingsSections } from '../ui-registry'
import { SettingsNavigation, navigationTitle, isFeatureSection } from './SettingsNavigation'
import { rememberSettingsForReload, takeSettingsAfterReload } from '../settings-recovery'
import { ThemeSettings } from './ThemeSettings'
import { PluginAppearanceSettings } from './PluginAppearanceSettings'
import { ApplicationSettings } from './ApplicationSettings'
import { DevelopmentPlugins } from './DevelopmentPlugins'
import { DatabaseMaintenance } from './DatabaseMaintenance'
import { PluginDataMaintenance } from './PluginDataMaintenance'
import { PluginChoices } from './PluginChoices'
import { ExtensionDiagnostics } from './ExtensionDiagnostics'
import type { ExternalBinding, PackageRef, PackageRow } from '../../../shared/external-plugins'
import { bindingsOf, choosePackage, enableRequiredPlugins, packageChanges, previewPluginSettings } from '../plugin-settings'
import { blockDevelopmentReload, useDevelopmentPlugins } from '../development-plugins'
import { SettingsHeader } from './SettingsHeader'

interface Props {
  host: UiHost
  libraryId: string
  onRequestClose(): Promise<boolean>
}

export function SettingsContent({ host, libraryId, onRequestClose }: Props) {
  const { locale } = useLanguage()
  const { directory: developmentDirectory } = useDevelopmentPlugins()
  const snapshot = useSyncExternalStore(host.settings.subscribe, host.settings.getSnapshot)
  const target = snapshot.target ?? { scope: 'library' as const, section: 'import' }
  const scope = target.scope
  const section = target.section

  const root = useRef<HTMLDivElement>(null)
  useModalFocus(root)
  const [maintenanceTab, setMaintenanceTab] = useState<'storage' | 'plugins'>('storage')
  const [presetBase, setPresetBase] = useState<PluginSelectionSnapshot>()
  const [presetBusy, setPresetBusy] = useState(false)
  const [presetRevision, setPresetRevision] = useState<string>()
  const [arrangement, setArrangement] = useState<PresetArrangement>()
  const [requestedPreset, setRequestedPreset] = useState<{ id: string; nonce: number }>()
  const [reloadPending, setReloadPending] = useState(false)
  const [plugins, setPlugins] = useState<PluginState[]>([])
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<PackageRow[]>([])
  const [savedPackages, setSavedPackages] = useState<ExternalBinding[]>([])
  const [draft, setDraft] = useState<ExternalBinding[]>([])
  const [retries, setRetries] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [developmentDirty, setDevelopmentDirty] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')

  const navigate = (nextScope: 'application' | 'library', nextSection?: string) => {
    setError('')
    void host
      .openSettings({ scope: nextScope, ...(nextSection ? { section: nextSection } : {}) })
      .then(ok => { if (!ok) setError(host.settings.getSnapshot().blockedReason ?? uiText("设置正在处理，请稍候")) })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    let alive = true
    void Promise.all([host.core.plugins(), window.bridge.packages.list(), host.pluginPresets.current()]).then(
      ([ps, rs, presetState]) => {
        if (!alive) return
        setPresetBase(presetState)
        setPlugins(ps.filter(p => !p.external))
        setDisabled(new Set(ps.filter(p => !p.external && p.chosen).map(p => p.id)))
        setRows(rs)
        setSavedPackages(bindingsOf(rs))
        setDraft(bindingsOf(rs))
        setLoading(false)
      },
      e => {
        if (alive) {
          setError(uiText("读取失败，请重新打开设置页：{value1}", { value1: String(String(e)) }))
          setLoadFailed(true)
          setLoading(false)
        }
      }
    )
    return () => {
      alive = false
    }
  }, [host])

  const refresh = useCallback(async () => setRows(await window.bridge.packages.list()), [])
  useUiEffect(display => {
    const load = () => {
      void refresh().catch(e => setError(String(e)))
    }
    const off = window.bridge.packages.onChanged(load)
    display.onWindow('focus', load)
    return () => {
      off()
    }
  }, [refresh])

  const displayRows: PackageRow[] = [
    ...rows,
    ...draft
      .filter(b => !rows.some(r => r.hash === b.hash))
      .map(b => ({ ...b, installed: false, selected: false, enabled: false, running: false }))
  ]
  const plan = useMemo(() => previewPluginSettings(disabled, plugins, draft, rows), [disabled, plugins, draft, rows])
  const saved = plugins.filter(p => p.chosen).map(p => p.id)
  const changes = packageChanges(savedPackages, draft, retries)
  const pluginDirty = saved.length !== disabled.size || saved.some(id => !disabled.has(id)) || changes.length > 0
  const dirty = pluginDirty || !!arrangement
  const selection = useMemo<PluginSelection>(() => {
    const external = new Map(presetBase?.selection.external.map(p => [p.id, p]))
    for (const p of draft) {
      if (!presetBase?.development.includes(p.manifest.id)) {
        external.set(p.manifest.id, { id: p.manifest.id, hash: p.hash, enabled: p.enabled })
      }
    }
    return { disabled: [...disabled], external: [...external.values()] }
  }, [disabled, draft, presetBase])
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const blocked = applying || loading || loadFailed || reloadPending || presetBusy
  const formState = useRef({ dirty: false, busy: false })
  formState.current = { dirty: dirty || developmentDirty || applying, busy: presetBusy }
  const applyingRef = useRef(applying)
  applyingRef.current = applying

  useEffect(
    () =>
      host.settings.registerGuard('host.plugin-selection', {
        state: () => ({ ...formState.current, message: uiText("请先应用或还原插件选择，再关闭设置") }),
        beforeLeave: intent => (intent.reason === 'navigate' ? !applyingRef.current : intent.reason === 'reload' && applyingRef.current)
      }),
    [host.settings]
  )

  useEffect(() => {
    blockDevelopmentReload('settings', dirty || applying)
    return () => blockDevelopmentReload('settings', false)
  }, [dirty, applying])

  const clearScheme = () => { setPresetRevision(undefined); setArrangement(undefined) }
  const enableDependencies = (id: string) => {
    setError('')
    try {
      const next = enableRequiredPlugins(id, disabled, plugins, draft, rows)
      setDisabled(next.disabled)
      setDraft(next.draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = (id: string) => {
    setError('')
    setDisabled(d => {
      const next = new Set(d)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectPackage = (ref: PackageRef, enabled: boolean) => {
    setError('')
    const retry = enabled && rows.some(p => p.hash === ref.hash && p.enabled && !p.running)
    if (retry && arrangement) {
      setError(uiText("请先应用或还原配套工作台安排，再重试插件"))
      return
    }
    if (retry) setPresetRevision(undefined)
    setDraft(d => choosePackage(d, savedPackages, ref, enabled))
    setRetries(r => {
      const next = new Set(r)
      for (const row of rows.filter(p => p.manifest.id === ref.manifest.id)) next.delete(row.hash)
      if (retry) next.add(ref.hash)
      return next
    })
  }

  const pages = useMemo(() => host.settings.pages(), [host.settings, snapshot.revision, locale])
  const pluginSections = settingsSections()
  const activePageMeta = pages.find(p => p.scope === scope && p.id === section)
  const appearanceSections = pluginSections.filter(s => s.category === 'appearance')

  const showDevelopment = !!developmentDirectory.directory || developmentDirectory.rows.length > 0 || developmentDirty || section === 'development'
  const developmentTab = (
    <button type="button" aria-pressed={section === 'development'} onClick={() => navigate('library', 'development')}>{uiText("本地源码开发")}</button>
  )

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as Element).closest('[role="dialog"]') !== e.currentTarget) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      void onRequestClose()
      return
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      e.stopPropagation()
    }
  }

  const rememberReopenOnReload = () => rememberSettingsForReload(libraryId, target)

  const openSpace = async (spaceId?: string) => {
    if (await onRequestClose()) host.openTab('file-spaces', spaceId ? { spaceId } : {})
  }

  return (
    <>
      <div
        className="settings settings-modal settings-window-content"
        role="dialog"
        aria-modal="false"
        aria-label={t('common.settings')}
        ref={root}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <SettingsHeader title={activePageMeta ? navigationTitle(activePageMeta) : t('common.settings')}
          scope={scope === 'application' ? t('common.appScope')
            : activePageMeta?.pluginTitle
              ? uiText("插件 · {pluginTitle} · 保存在{value2}", { pluginTitle: activePageMeta.pluginTitle, value2: activePageMeta.storage === 'local' ? uiText("本机") : uiText("仓库") })
              : activePageMeta?.storage === 'local' ? uiText("当前仓库 · 保存在本机") : t('settings.library')}
          onClose={onRequestClose} />
        {snapshot.blockedReason && <div className="settings-window-warning" role="alert">{snapshot.blockedReason}</div>}
        <SettingsNavigation pages={pages} scope={scope} section={section} dirty={dirty || developmentDirty} navigate={navigate} />

        <div className="settings-main">
          {scope === 'application' && error && <p className="package-error" role="alert">{error}</p>}
          <div className="settings-application" hidden={scope !== 'application'}>
            <ApplicationSettings windowLibrary={{ libraryId, root: host.root }} onOpenSpace={openSpace} onPreviewPreset={async id => {
              const ok = await host.openSettings({ scope: 'library', section: 'plugin-presets' })
              if (!ok) throw new Error(host.settings.getSnapshot().blockedReason ?? uiText("暂时无法打开方案"))
              setRequestedPreset({ id, nonce: Date.now() })
            }} settings={host.settings} section={scope === 'application' ? section : undefined} hideNav />
          </div>

          <div className="settings-library" hidden={scope !== 'library'}>
            <div className="settings-content">
              {scope === 'library' && (section === 'library-appearance' || activePageMeta?.category === 'appearance') && (
                <div className="settings-section-card active" data-settings-section="library-appearance">
                  <ThemeSettings libraryId={libraryId}>
                    {appearanceSections.length > 0 && <PluginAppearanceSettings host={host} sections={appearanceSections}
                      active={section} navigate={id => navigate('library', id)} />}
                  </ThemeSettings>
                </div>
              )}
              {isFeatureSection(section) && <div className="settings-subnav" role="group" aria-label={t('settings.features')}>
                <button type="button" aria-pressed={section === 'plugins'} onClick={() => navigate('library', 'plugins')}>{uiText("启停功能")}</button>
                <button type="button" aria-pressed={section === 'plugin-presets'} onClick={() => navigate('library', 'plugin-presets')}>{uiText("方案组合")}</button>
                {showDevelopment ? developmentTab : <details className="settings-advanced-tab">
                  <summary>{uiText("高级")}</summary>{developmentTab}
                </details>}
              </div>}
              <div
                data-settings-section="import"
                className={`settings-section-card${section === 'import' ? ' active' : ''}`}
                hidden={section !== 'import'}
              >
                <ImportSettingsPanel host={host} openSpace={openSpace} active={scope === 'library' && section === 'import'} />
              </div>

              <div
                data-settings-section="plugin-presets"
                className={`settings-section-card${section === 'plugin-presets' ? ' active' : ''}`}
                hidden={section !== 'plugin-presets'}
              >
                {presetBase && (
                  <PluginPresets
                    active={scope === 'library' && section === 'plugin-presets'}
                    api={host.pluginPresets}
                    workbench={host.workbenchPresets}
                    requested={requestedPreset}
                    settings={host.settings}
                    onActivity={setPresetBusy}
                    selection={selection}
                    busy={blocked || developmentDirty}
                    dirty={dirty}
                    development={presetBase.development}
                    onUse={async (preview, layout) => {
                      const before = JSON.stringify(selectionRef.current)
                      const fresh = await window.bridge.packages.list()
                      if (JSON.stringify(selectionRef.current) !== before) throw new Error(uiText("勾选已变化，请重新预演组合"))
                      const next = preview.selection.external
                        .filter(p => !presetBase.development.includes(p.id))
                        .map(p => {
                          const ref = fresh.find(r => r.hash === p.hash) ?? savedPackages.find(r => r.hash === p.hash)
                          if (!ref) throw new Error(uiText("插件版本已变化，请重新预演"))
                          return { manifest: ref.manifest, hash: p.hash, enabled: p.enabled }
                        })
                      setRows(fresh)
                      setDisabled(new Set(preview.selection.disabled))
                      setDraft([...next, ...draft.filter(p => presetBase.development.includes(p.manifest.id))])
                      setRetries(new Set())
                      setPresetRevision(layout || pluginDirty || preview.changes.length ? preview.revision : undefined)
                      setArrangement(layout)
                      setError('')
                    }}
                  />
                )}
              </div>

              <div
                data-settings-section="plugins"
                className={`settings-section-card${section === 'plugins' ? ' active' : ''}`}
                hidden={section !== 'plugins'}
              >
                <ExtensionDiagnostics host={host} />
                <PluginChoices
                  plugins={plugins}
                  rows={displayRows.filter(r => !r.development)}
                  draft={draft}
                  disabledIds={disabled}
                  retries={retries}
                  plan={plan}
                  busy={blocked || developmentDirty}
                  onToggle={toggle}
                  onSelect={selectPackage}
                  onEnableRequired={enableDependencies}
                  onRetry={hash => {
                    if (arrangement) {
                      setError(uiText("请先应用或还原配套工作台安排，再重试插件"))
                      return
                    }
                    setPresetRevision(undefined)
                    setError('')
                    setRetries(r => {
                      const next = new Set(r)
                      if (next.has(hash)) next.delete(hash)
                      else next.add(hash)
                      return next
                    })
                  }}
                />
              </div>

              <div
                data-settings-section="development"
                className={`settings-section-card${section === 'development' ? ' active' : ''}`}
                hidden={section !== 'development'}
              >
                <DevelopmentPlugins
                  disabled={blocked}
                  dirty={dirty}
                  onActivity={setApplying}
                  onDraftChange={setDevelopmentDirty}
                />
              </div>

              <div
                data-settings-section="maintenance"
                className={`settings-section-card${section === 'maintenance' ? ' active' : ''}`}
                hidden={section !== 'maintenance'}
              >
                <div className="settings-subnav" role="group" aria-label={t('settings.maintenance')}>
                  <button aria-pressed={maintenanceTab === 'storage'} onClick={() => setMaintenanceTab('storage')}>{uiText("存储与 AI 任务记录")}</button>
                  <button aria-pressed={maintenanceTab === 'plugins'} onClick={() => setMaintenanceTab('plugins')}>{uiText("插件数据与偏好重置")}</button>
                </div>
                <div className="maintenance-pane" hidden={maintenanceTab !== 'storage'}>
                  <DatabaseMaintenance host={host} active={scope === 'library' && section === 'maintenance' && maintenanceTab === 'storage'} />
                </div>
                <div className="maintenance-pane" hidden={maintenanceTab !== 'plugins'}>
                  <PluginDataMaintenance host={host} active={scope === 'library' && section === 'maintenance' && maintenanceTab === 'plugins'} />
                </div>
              </div>

              {pluginSections.filter(s => s.category !== 'appearance').map(({ id, description, Component }) => (
                <div
                  key={id}
                  data-settings-section={id}
                  className={`settings-section-card plugin-settings-card${section === id ? ' active' : ''}`}
                  hidden={section !== id}
                >
                  {description && <p className="plugin-settings-card-desc muted">{description}</p>}
                  <Component host={host} />
                </div>
              ))}
            </div>

            {(dirty || reloadPending || error || loading || developmentDirty) && (
              <div className={`settings-foot${dirty || reloadPending || error ? ' is-dirty' : ''}`}>
                <span className={error ? 'package-error' : 'muted'} role={error ? 'alert' : undefined}>
                  {error ||
                    (developmentDirty
                      ? uiText("请先在本地源码开发中应用或还原选择")
                      : dirty
                        ? arrangement && !pluginDirty ? uiText("待应用配套工作台安排，无需重新加载") : uiText("有未应用的更改，统一应用后生效")
                        : loading
                          ? uiText("正在读取插件设置…")
                          : '')}
                </span>
                {reloadPending && (
                  <button
                    className="small"
                    disabled={applying}
                    onClick={() => {
                      setApplying(true)
                      rememberReopenOnReload()
                      void window.bridge.vaults.reload().catch(e => {
                        setError(String(e))
                        setApplying(false)
                      })
                    }}
                  >{uiText("重试重新加载")}{' '}</button>
                )}
                {dirty && (
                  <button
                    className="small"
                    disabled={blocked}
                    onClick={() => {
                      setDisabled(new Set(saved))
                      setDraft(savedPackages)
                      setRetries(new Set())
                      clearScheme()
                      setError('')
                    }}
                  >{uiText("还原更改")}{' '}</button>
                )}
                {dirty && (
                  <button
                    className="primary"
                    disabled={!dirty || blocked || developmentDirty}
                    onClick={async () => {
                      setApplying(true)
                      setError('')
                      rememberReopenOnReload()
                      try {
                        if (presetRevision) {
                          const result = await host.pluginPresets.apply(selection, presetRevision, arrangement)
                          if (!result.reloaded) {
                            takeSettingsAfterReload(libraryId)
                            setPresetBase(await host.pluginPresets.current())
                            clearScheme(); setApplying(false)
                          }
                        }
                        else {
                          await window.bridge.packages.apply({ disabled: [...disabled], changes })
                          await window.bridge.vaults.reload()
                        }
                      } catch (e) {
                        const message = e instanceof Error ? e.message : String(e)
                        setError(message)
                        setReloadPending(message.includes('[PLUGIN_PRESET_RELOAD]'))
                        setApplying(false)
                      }
                    }}
                  >
                    {arrangement && !pluginDirty ? uiText("应用工作台安排") : uiText("应用并重新加载")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
