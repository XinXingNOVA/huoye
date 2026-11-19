import { useEffect, useState } from 'react'
import type { SuiteRegistration } from '../../../shared/plugin-suites'
import { SectionHeader } from './ui-primitives'
import { suitePresetId } from '../../../shared/plugin-suites'

/** 套件只拥有静态方案目录；移除目录不会连带卸载可被其他方案复用的包。 */
export function PluginSuites({
  disabled, onInstall,
  onUpdate,
  onPreviewPreset
}: {
  onInstall(): void
  disabled: boolean
  onUpdate(id: string): void
  onPreviewPreset?(id: string): Promise<void>
}) {
  const [suites, setSuites] = useState<SuiteRegistration[]>(), [error, setError] = useState('')
  const [removing, setRemoving] = useState<string>(), [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true, sequence = 0
    const load = async () => {
      const seq = ++sequence
      try {
        const rows = await window.bridge.packages.suites()
        if (alive && seq === sequence) { setError(''); setSuites(rows) }
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
  }, [])
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
      <SectionHeader className="package-heading" title="已登记套件" badge={suites?.length ? `${suites.length} 项` : undefined}
        actions={<button className="small primary" disabled={disabled || busy} onClick={onInstall}>安装套件或插件包…</button>} />
      {suites?.length === 0 && !error && <p className="muted">本机还没有登记套件。</p>}
      <div className="plugin-suites-list">
        {suites?.map(s => (
          <article key={s.manifest.id} className="plugin-suite-card plugin-presets-preview">
            <div className="plugin-suite-head">
              <div>
                <strong>
                  {s.manifest.title} <span className="muted">{s.manifest.version}</span>
                </strong>
                {s.manifest.description && <p className="muted">{s.manifest.description}</p>}
              </div>
              <button className="small" disabled={disabled || busy} onClick={() => onUpdate(s.manifest.id)}>更新套件…</button>
              {removing !== s.manifest.id && (
                <button
                  className="small"
                  disabled={disabled || busy}
                  onClick={() => setRemoving(s.manifest.id)}
                >
                  移除套件…
                </button>
              )}
            </div>
            {!!s.missing?.length && <p className="muted">插件待补齐：{s.missing?.join('、')}；可重新添加套件或单独安装插件。</p>}
            <ul className="plugin-suite-presets">
              {s.manifest.presets.map(p => (
                <li key={p.id}>
                  <span>{p.title}</span>
                  {onPreviewPreset && (
                    <button
                      className="small primary"
                      disabled={disabled || busy}
                      data-preview-preset={suitePresetId(s.manifest.id, p.id)}
                      onClick={() => void run(() => onPreviewPreset(suitePresetId(s.manifest.id, p.id)))}
                    >
                      预览方案
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {removing === s.manifest.id && (
              <div className="plugin-suite-remove-confirm">
                <p>仅移除原版方案，保留已安装插件、用户副本与仓库数据。</p>
                <div className="plugin-presets-actions">
                  <button className="small" disabled={busy} onClick={() => setRemoving(undefined)}>
                    取消
                  </button>
                  <button
                    className="small danger"
                    disabled={disabled || busy}
                    onClick={() =>
                      void run(async () => {
                        await window.bridge.packages.removeSuite(s.manifest.id, s.hash)
                        setRemoving(undefined)
                      })
                    }
                  >
                    确认移除套件
                  </button>
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
