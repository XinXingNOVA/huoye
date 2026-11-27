import { uiText } from '../../../shared/i18n/interface-display'
import { useLanguage } from '../language'
import { packageText } from '../../../shared/package-locales'
import { useEffect, useState } from 'react'
import type { SuiteRegistration } from '../../../shared/plugin-suites'
import { SectionHeader } from './ui-primitives'
import { suitePresetId } from '../../../shared/plugin-suites'

/** 套件只拥有静态方案目录；移除目录不会连带卸载可被其他方案复用的包。 */
export function PluginSuites({
  disabled, onInstall,
  onUpdate,
  onMembers,
  onRegistrations,
  onPreviewPreset
}: {
  onInstall(): void
  disabled: boolean
  onRegistrations(rows: SuiteRegistration[]): void
  onMembers(suite: SuiteRegistration): void
  onUpdate(id: string): void
  onPreviewPreset?(id: string): Promise<void>
}) {
  const { locale } = useLanguage()
  const [suites, setSuites] = useState<SuiteRegistration[]>(), [error, setError] = useState('')
  const [removing, setRemoving] = useState<string>(), [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true, sequence = 0
    const load = async () => {
      const seq = ++sequence
      try {
        const rows = await window.bridge.packages.suites()
        if (alive && seq === sequence) { setError(''); setSuites(rows); onRegistrations(rows) }
      } catch (e) {
        if (alive && seq === sequence) setError(String(e))
      }
    }
    void load()
    const off = window.bridge.packages.onChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [onRegistrations])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="plugin-suites">
      <SectionHeader className="package-heading" title={uiText("已登记套件")} badge={suites?.length ? uiText("{length} 项", { length: String(suites.length) }) : undefined}
        actions={<button className="small primary" disabled={disabled || busy} onClick={onInstall}>{uiText("安装套件或插件包…")}</button>} />
      {suites?.length === 0 && !error && <p className="muted">{uiText("本机还没有登记套件。")}</p>}
      <div className="plugin-suites-list">
        {suites?.map(s => (
          <article key={s.manifest.id} className="plugin-suite-card plugin-presets-preview">
            <div className="plugin-suite-head">
              <strong>{packageText(s.manifest.locales, locale, s.manifest.title)} <small className="muted">v{s.manifest.version}</small></strong>
              <button className="small" disabled={disabled || busy} onClick={() => onMembers(s)}>{uiText("{n} 个插件", { n: s.manifest.packages.length })}</button>
            </div>
            {s.manifest.description && <p className="suite-description muted" title={packageText(s.manifest.locales, locale, s.manifest.description)}>{packageText(s.manifest.locales, locale, s.manifest.description)}</p>}
            {!!s.missing?.length && <p className="plugin-warn">{uiText("插件待补齐：")}{s.missing.join('、')}</p>}
            <div className="suite-controls">
              <ul className="plugin-suite-presets">{s.manifest.presets.map(p => (
                <li key={p.id}>{onPreviewPreset ?
                  <button className="small" disabled={disabled || busy}
                    aria-label={uiText("预览方案") + ' · ' + packageText(s.manifest.locales, locale, p.title)}
                    data-preview-preset={suitePresetId(s.manifest.id, p.id)}
                    onClick={() => void run(() => onPreviewPreset(suitePresetId(s.manifest.id, p.id)))}>
                    {packageText(s.manifest.locales, locale, p.title)}
                  </button> : <span>{packageText(s.manifest.locales, locale, p.title)}</span>}</li>
              ))}</ul>
              <div className="suite-actions">
                <button className="small" disabled={disabled || busy} onClick={() => onUpdate(s.manifest.id)}>{uiText("更新套件…")}</button>
                {removing !== s.manifest.id && <button className="small" disabled={disabled || busy} onClick={() => setRemoving(s.manifest.id)}>{uiText("移除套件…")}</button>}
              </div>
            </div>
            {removing === s.manifest.id && (
              <div className="plugin-suite-remove-confirm">
                <p>{uiText("仅移除原版方案，保留已安装插件、用户副本与仓库数据。")}</p>
                <div className="plugin-presets-actions">
                  <button className="small" disabled={busy} onClick={() => setRemoving(undefined)}>{uiText("取消")}{' '}</button>
                  <button
                    className="small danger"
                    disabled={disabled || busy}
                    onClick={() =>
                      void run(async () => {
                        await window.bridge.packages.removeSuite(s.manifest.id, s.hash)
                        setRemoving(undefined)
                      })
                    }
                  >{uiText("确认移除套件")}{' '}</button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {error && (
        <p className="package-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
