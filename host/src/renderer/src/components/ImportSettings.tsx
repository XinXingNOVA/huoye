import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef, useState } from 'react'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import type { ImportSettings } from '../../../shared/import-settings'
import { updateImportPolicy } from '../import-policy'
import type { UiHost } from '../plugin'
import { LibrarySpaceLinks } from './FileSpaces'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'
import './import-settings.css'

const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export function ImportSettingsPanel({ host, active, openSpace }: { host: UiHost; active: boolean; openSpace(id?: string): void }) {
  useUiLocale()
  const [settings, setSettings] = useState<ImportSettings>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const saving = useRef(false), revision = useRef(0)
  const reload = async (clearError = true) => {
    const ticket = ++revision.current
    try {
      const value = await host.core.getImportSettings()
      if (ticket !== revision.current) return
      setSettings(value)
      if (clearError) setError('')
    } catch (e) {
      if (ticket === revision.current && clearError) setError(message(e))
    }
  }
  useUiEffect(display => {
    if (!active) return
    const load = () => {
      if (!saving.current) void reload()
    }
    load()
    display.onWindow('focus', load)
    return () => { revision.current++ }
  }, [active, host.core])
  useEffect(() => host.settings.registerGuard('host.import-settings', {
    state: () => ({ busy: saving.current, message: uiText("正在保存导入规则，请稍候") })
  }), [host.settings])
  const save = async (change: Parameters<typeof updateImportPolicy>[1]) => {
    if (saving.current) return
    saving.current = true; revision.current++; setBusy(true); setError(''); setNotice('')
    try {
      setSettings(await updateImportPolicy(host.core, change))
      setNotice(uiText("导入规则已保存。"))
    } catch (e) {
      setError(message(e))
      await reload(false)
    } finally { saving.current = false; setBusy(false) }
  }
  const bindings = settings?.bindings.filter(s => s.state === 'active') ?? []

  return <section className="import-settings" aria-label={uiText("导入与收录")}>
    <SectionHeader title={uiText("默认导入规则")} actions={<button className="small" disabled={busy} onClick={() => openSpace(settings?.defaultSpaceId)}>{uiText("打开文件空间工作台 →")}</button>} />
    {error && <p className="package-error" role="alert">{error} {!settings && <button className="small" onClick={() => void reload()}>{uiText("重新读取")}</button>}</p>}
    {settings ? <>
      <SettingGroup className="import-setting-fields">
        <SettingRow title={<label htmlFor="import-default-space">{uiText("默认保存空间")}</label>}>
          <select id="import-default-space" value={settings.defaultSpaceId} disabled={busy} onChange={e => void save({ defaultSpaceId: e.target.value })}>
            {bindings.map(s => <option key={s.id} value={s.id} disabled={!!s.error}>{s.name} · {s.error ? uiText("不可用") : s.mode === 'shared' ? uiText("共享") : uiText("独享")}</option>)}
          </select>
        </SettingRow>
        <SettingRow title={<label htmlFor="import-default-collect">{uiText("拖入、粘贴或导入文件时")}</label>}>
          <select id="import-default-collect" value={String(settings.collect)} disabled={busy} onChange={e => void save({ collect: e.target.value === 'true' })}>
            <option value="true">{uiText("保存并立即收录")}</option><option value="false">{uiText("只保存，稍后收录")}</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={uiText("各空间的收录规则")}>
        {bindings.map(s => {
          const rule = settings.spaces.find(r => r.spaceId === s.id)
          return <SettingRow key={s.id} className="import-space-rule" title={s.name}
            description={s.error ? uiText("空间不可用") : uiText("未收录 {value1} 项{value2}", { value1: String(s.uncollected ?? 0), value2: String(s.pending ? uiText(" · 自动收录待处理 ") + s.pending + uiText(" 项") : '') })}>
            <label>{uiText("新增文件")}<select value={String(rule?.automatic ?? false)} disabled={busy}
              onChange={e => void save({ space: { spaceId: s.id, automatic: e.target.value === 'true' } })}>
              <option value="false">{uiText("手动收录")}</option><option value="true" disabled={!!s.error}>{uiText("自动收录")}</option>
            </select></label>
            {s.versioned && <label>{uiText("原件新版")}<select value={rule?.updates ?? 'manual'} disabled={busy || !!s.error}
              onChange={e => void save({ space: { spaceId: s.id, updates: e.target.value === 'automatic' ? 'automatic' : 'manual' } })}>
              <option value="manual">{uiText("预览后接纳")}</option><option value="automatic">{uiText("自动接纳")}</option>
            </select></label>}
          </SettingRow>
        })}
      </SettingGroup>
      <details className="import-links"><summary>{uiText("管理关联空间（")}{bindings.length}）</summary>
        <LibrarySpaceLinks host={host} rows={settings.bindings} disabled={busy} changed={reload} openSpace={openSpace} />
      </details>
    </> : !error && <p className="muted">{uiText("正在读取导入规则…")}</p>}
    <p className="muted import-notice" role="status">{busy ? uiText("正在保存…") : notice}</p>
  </section>
}
