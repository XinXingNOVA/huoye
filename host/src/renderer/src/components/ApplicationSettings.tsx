import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { GlobalPluginDataMaintenance } from './PluginLocalDataMaintenance'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { ApplicationFileSpaces } from './FileSpaces'
import { LanguageSettings } from './LanguageSettings'
import { ThemeSettings } from './ThemeSettings'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applicationSections, applicationSettingsPages } from '../application-settings-catalog'
import type { ApplicationSettingsProps, ApplicationUiHost } from '../../../plugin-api/ui/application'
import type { SettingsService } from '../../../plugin-api/ui/settings'
import type { PackageRow } from '../../../shared/external-plugins'
import { LocalEditorSettings } from './LocalEditors'
import { PluginPackages } from './PluginPackages'
import { SettingsNavigation, isLocalSection } from './SettingsNavigation'

const noop = () => {}
const emptyPlan = { enabled: new Set<string>(), off: new Map<string, string>() }

export function ApplicationSettings({
  windowLibrary,
  onOpenSpace,
  settings,
  section = 'appearance',
  hideNav = false,
  onPreviewPreset,
  presetActionLabel,
  onInstalledPresets
}: {
  windowLibrary?: ApplicationSettingsProps['windowLibrary']
  onOpenSpace?(id: string): void
  settings: SettingsService
  section?: string
  hideNav?: boolean
  onInstalledPresets?(ids: string[]): void
  presetActionLabel?: string
  onPreviewPreset?(id: string): Promise<void>
}) {
  const locale = useUiLocale()
  const page = section
  const [packageActivity, setPackageActivity] = useState(false)
  const packageActivityRef = useRef(false)
  packageActivityRef.current = packageActivity
  const packageActivityChanged = useCallback((busy: boolean) => { packageActivityRef.current = busy; setPackageActivity(busy) }, [])
  useEffect(() => settings.registerGuard('host.package-installation', {
    state: () => ({ busy: packageActivityRef.current, message: uiText("请先完成或取消插件包操作") })
  }), [settings])
  const [visited, setVisited] = useState(() => new Set([section]))
  useEffect(() => setVisited(previous => previous.has(section) ? previous : new Set([...previous, section])), [section])
  const host = useMemo<ApplicationUiHost>(
    () => ({
      settings,
      openSettings: target => settings.open(target),
      service: (plugin, method, input) => window.bridge.application.service(plugin, method, input),
      pickDirectory: () => window.bridge.vaults.pick('parent')
    }),
    [settings]
  )
  const setPage = (nextSection: string) => {
    void settings
      .open({ scope: 'application', section: nextSection })
      .then(ok => {
        if (!ok) setError(settings.getSnapshot().blockedReason ?? uiText("设置正在处理，请稍候"))
      })
      .catch(e => setError(String(e)))
  }
  const [rows, setRows] = useState<PackageRow[]>([]),
    [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    setRows(await window.bridge.packages.installed())
  }, [])
  useUiEffect(display => {
    let active = true
    const load = () => {
      void window.bridge.packages.installed().then(
        rs => {
          if (active) {
            setRows(rs)
            setLoading(false)
          }
        },
        e => {
          if (active) {
            setError(String(e))
            setLoading(false)
          }
        }
      )
    }
    load()
    const off = window.bridge.packages.onChanged(load)
    display.onWindow('focus', load)
    return () => {
      active = false
      off()
    }
  }, [])

  const pages = useMemo(applicationSettingsPages, [locale])

  return (
    <div className={`application-settings${hideNav ? ' embedded' : ''}`}>
      {!hideNav && <SettingsNavigation pages={pages} scope="application" section={page} navigate={(_, id) => setPage(id)} />}
      <div className="settings-content">
        {isLocalSection(page) && <div className="settings-subnav" role="group" aria-label={uiText("文件空间与外部应用")}>
          <button aria-pressed={page === 'spaces'} onClick={() => setPage('spaces')}>{uiText("文件空间")}</button>
          <button aria-pressed={page === 'editors'} onClick={() => setPage('editors')}>{uiText("外部编辑器")}</button>
        </div>}
        {visited.has('editors') && (
          <div className="settings-section-card active" data-settings-section="editors" hidden={page !== 'editors'}>
            <LocalEditorSettings />
          </div>
        )}
        {page === 'language' && <div className="settings-section-card active" data-settings-section="language"><LanguageSettings /></div>}
        {visited.has('appearance') && (
          <div className="settings-section-card active" data-settings-section="appearance" hidden={page !== 'appearance'}>
            <ThemeSettings />
          </div>
        )}
        {visited.has('spaces') && (
          <div className="settings-section-card active" data-settings-section="spaces" hidden={page !== 'spaces'}>
            <ApplicationFileSpaces onOpenSpace={onOpenSpace} visible={page === 'spaces'} />
          </div>
        )}
        {error && (
          <p role="alert" className="package-error">
            {error}
          </p>
        )}
        {applicationSections()
          .filter(s => visited.has(s.id))
          .map(({ id, Component }) => (
            <div key={id} className="settings-section-card active" data-settings-section={id} hidden={page !== id}>
              <Component host={host} windowLibrary={windowLibrary} />
            </div>
          ))}
        {visited.has('packages') && (
          <div className="settings-section-card active" data-settings-section="packages" hidden={page !== 'packages'}>
            <PluginPackages
              scope="application"
              rows={rows}
              draft={[]}
              retries={emptyPlan.enabled}
              plan={emptyPlan}
              disabled={loading}
              onRefresh={refresh}
              onActivity={packageActivityChanged}
              onPreviewPreset={onPreviewPreset}
              presetActionLabel={presetActionLabel}
              onInstalledPresets={onInstalledPresets}
              onSelect={noop}
              onRetry={noop}
              onUninstalled={noop}
            />
            <GlobalPluginDataMaintenance settings={settings} active={page === 'packages'} />
          </div>
        )}
      </div>
    </div>
  )
}
