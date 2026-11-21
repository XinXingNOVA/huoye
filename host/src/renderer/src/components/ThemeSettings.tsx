import { hostLabel, uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { DecorationSettings } from './DecorationSettings'
import { useId, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedControl } from '../../../plugin-api/ui/kit'
import type { ThemeAction } from '../../../shared/appearance'
import { ACCENT_SWATCHES, changeTheme, installTheme, activeTheme, themeDisplayName, themeForMode, resolveThemeTokens, uninstallTheme, useThemeSettings, type ThemePreferences } from '../theme'
import { FEATURED_THEMES, THEME_PRESETS } from '../../../shared/builtin-themes'
import { CLASSIC_THEMES, type ThemePreset } from '../../../shared/theme-presets'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'

const CUSTOM_COLOR_FIELDS: { key: keyof NonNullable<ThemePreferences['customTokens']>; label: string }[] = [
  { key: 'shell', get label() { return uiText("外框壳层") } },
  { key: 'panel', get label() { return uiText("侧栏与检查器") } },
  { key: 'bg', get label() { return uiText("主画布背景") } },
  { key: 'text', get label() { return uiText("主文字") } },
  { key: 'paper', get label() { return uiText("阅读纸张") } }
]

function ThemeCard({ preset, active, onSelect }: { preset: ThemePreset; active: boolean; onSelect(): void }) {
  useUiLocale()
  const builtin = THEME_PRESETS.some(theme => theme.id === preset.id)
  const name = themeDisplayName(preset)
  const description = builtin ? hostLabel(preset.description) : preset.description
  const descriptionId = useId()
  const t = preset.tokens
  const preview = preset.preview && preset.images?.[preset.preview]
  const [failedPreview, setFailedPreview] = useState<string>()
  return (
    <button
      type="button"
      className={`theme-preset-card${active ? ' active' : ''}`}
      aria-label={name}
      aria-describedby={preset.description ? descriptionId : undefined}
      aria-pressed={active}
      onClick={onSelect}
    >
      {preview && preview !== failedPreview
        ? <img className="theme-preview-mini theme-preview-image" src={preview} alt="" decoding="async" loading="lazy"
            style={{ background: t.shell, borderColor: t.line }} onError={() => setFailedPreview(preview)} />
        : <div className="theme-preview-mini" aria-hidden="true" data-density={preset.appearance?.density}
        data-inset={!!preset.appearance?.panelInset || undefined} style={{ background: t.shell, borderColor: t.line }}>
        <div className="theme-preview-sidebar" style={{ background: t.panel, borderRightColor: t.line }}>
          <span style={{ background: t.accent }} />
          <span style={{ background: t.panel2 }} />
        </div>
        <div className="theme-preview-canvas" style={{ background: t.bg }}>
          <div className="theme-preview-card" style={{ background: t.paper }} />
          <div className="theme-preview-card" style={{ background: t.panel2 }} />
        </div>
        <div className="theme-preview-inspector" style={{ background: t.panel, borderLeftColor: t.line }} />
      </div>}
      <div className="theme-preset-meta">
        <div className="theme-preset-title">
          <strong>{name}</strong>
          <span className="theme-scheme-badge">{preset.variants ? uiText("昼夜") : t.scheme === 'light' ? uiText("浅色") : uiText("深色")}</span>
        </div>
        <p id={descriptionId} className="muted">{description}</p>
      </div>
    </button>
  )
}

export function ThemeSettings({ libraryId, children }: { libraryId?: string; children?: ReactNode }) {
  useUiLocale()
  const { prefs, independent, installed, warning, decoration } = useThemeSettings(libraryId)
  const picker = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  async function change(action: () => Promise<void>) {
    setError('')
    setNotice('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : uiText("保存外观设置失败")) }
  }
  const update = (action: ThemeAction) => change(() => changeTheme(action, libraryId))
  const install = async (file: File) => {
    setInstalling(true)
    setError('')
    setNotice('')
    try {
      await installTheme(file)
      setNotice(uiText("主题包已安装到本机"))
    } catch (e) {
      setError(e instanceof Error ? e.message : uiText("安装主题失败"))
    } finally {
      setInstalling(false)
    }
  }
  const cardFor = (preset: ThemePreset) => <ThemeCard key={preset.id} preset={themeForMode(preset, prefs.presetId === preset.id ? prefs.colorMode : 'system')}
    active={prefs.presetId === preset.id} onSelect={() => update({ action: 'select', id: preset.id })} />
  const active = activeTheme(prefs)
  const activeTokens = resolveThemeTokens(prefs, active)
  const hasCustom = !!(prefs.accent || (prefs.customTokens && Object.keys(prefs.customTokens).length > 0))

  if (libraryId && !independent) {
    return <section className="theme-settings" aria-label={uiText("本库外观")}>
      <SectionHeader title={uiText("跟随应用默认外观")} subtitle={uiText("当前使用「{name}」。单独设置后，只影响本机上的这个仓库和它的小窗。", { name: themeDisplayName(active) })}
        actions={<Button variant="primary" onClick={() => update({ action: 'independent' })}>{uiText("单独设置")}</Button>} />
      {warning && <p role="status" className="muted">{warning}</p>}
      {error && <p role="alert" className="package-error">{error}</p>}
      {children}
    </section>
  }
  return (
    <section className="theme-settings" aria-label={libraryId ? uiText("本库外观") : uiText("外观与主题")}>
      <SectionHeader
        title={libraryId ? uiText("本库独立外观") : uiText("应用默认外观")}
        subtitle={libraryId ? uiText("主题与细节保存在本机，内容小窗同步使用。") : uiText("用于开始页和所有跟随应用的仓库。")}
        actions={<>
          {libraryId && <Button onClick={() => update({ action: 'follow' })}>{uiText("恢复跟随应用")}</Button>}
          {prefs.previousBuiltin && <Button className="theme-restore" onClick={() => update({ action: 'restore' })}>{uiText("还原内置外观")}</Button>}
          <Button variant="primary" disabled={installing} onClick={() => picker.current?.click()}>{uiText("安装主题包…")}</Button>
        </>}
      />
      <input ref={picker} hidden type="file" aria-label={uiText("选择主题包")} accept=".hytheme" onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) void install(file)
      }} />
      {warning && <p role="status" className="muted">{warning}</p>}
      {error && <p role="alert" className="package-error">{error}</p>}
      {notice && <p role="status" className="muted">{notice}</p>}

      <div className="theme-group">
        <h3>{uiText("内置主题")}</h3>
        <div className="theme-preset-grid theme-featured-grid">{FEATURED_THEMES.map(cardFor)}</div>
        <details className="theme-classics" open={CLASSIC_THEMES.some(theme => theme.id === prefs.presetId)}>
          <summary>{uiText("经典主题")}</summary>
          <div className="theme-preset-grid">{CLASSIC_THEMES.map(cardFor)}</div>
        </details>
      </div>

      {active.variants && <SettingGroup title={uiText("昼夜外观")}>
        <SettingRow title={uiText("明暗模式")} description={uiText("当前使用{value1}版本", { value1: String(active.tokens.scheme === 'dark' ? uiText("深色") : uiText("浅色")) })}>
          <SegmentedControl label={uiText("明暗模式")} value={prefs.colorMode ?? 'system'}
            options={[{ value: 'system', label: uiText("跟随系统") }, { value: 'light', label: uiText("固定浅色") }, { value: 'dark', label: uiText("固定深色") }]}
            onChange={value => update({ action: 'colorMode', value: value as NonNullable<ThemePreferences['colorMode']> })} />
        </SettingRow>
      </SettingGroup>}
      {installed.length > 0 && <div className="theme-group">
        <h3>{uiText("已安装主题")}</h3>
        <div className="theme-preset-grid">
          {installed.map(preset => <div key={preset.id} className="theme-installed-card">
            {cardFor(preset)}
            {!libraryId && <Button size="sm" variant="ghost" aria-label={uiText("移除主题：") + preset.name}
              onClick={() => change(() => uninstallTheme(preset.id))}>{uiText("移除")}</Button>}
          </div>)}
        </div>
      </div>}
      {libraryId && <DecorationSettings preset={active}
        local={decoration} update={update} run={change} />}
      <SettingGroup title={uiText("界面细节")}>
        <SettingRow title={uiText("强调色")} description={uiText("用于高亮选中项、主操作按钮与活动指示")}>
          <div className="theme-swatches">
            {ACCENT_SWATCHES.map((s) => {
              const current = activeTokens.accent.toLowerCase() === s.value.toLowerCase()
              return (
                <button
                  key={s.value}
                  type="button"
                  className={`theme-swatch-btn${current ? ' active' : ''}`}
                  title={s.name}
                  aria-label={uiText("强调色：{name}", { name: String(s.name) })}
                  aria-pressed={current}
                  onClick={() => update({ action: 'accent', value: s.value })}
                >
                  <span className="theme-swatch-dot" style={{ background: s.value }} />
                  <span>{s.name}</span>
                </button>
              )
            })}
            <label className="theme-custom-color" title={uiText("自定义强调色")}>
              <input
                type="color"
                value={activeTokens.accent}
                onChange={(e) => update({ action: 'accent', value: e.target.value })}
              />
              <span className="muted">{uiText("自定义")}</span>
            </label>
          </div>
        </SettingRow>

        <SettingRow title={uiText("界面密度")} description={uiText("调整列表、侧栏与检查器的内边距")}>
          <SegmentedControl label={uiText("界面密度")} value={prefs.density}
            options={[{ value: 'comfortable', label: uiText("舒展") }, { value: 'compact', label: uiText("紧凑") }]}
            onChange={value => update({ action: 'density', value: value as typeof prefs.density })} />
        </SettingRow>

        <SettingRow title={uiText("控件圆角")} description={uiText("调整卡片、输入框与按钮的圆角风格")}>
          <SegmentedControl label={uiText("控件圆角")} value={prefs.radius}
            options={[{ value: 'sharp', label: uiText("利落") }, { value: 'rounded', label: uiText("标准") }, { value: 'soft', label: uiText("柔和") }]}
            onChange={value => update({ action: 'radius', value: value as typeof prefs.radius })} />
        </SettingRow>
      </SettingGroup>

      {hasCustom && <Button size="sm" onClick={() => update({ action: 'resetColors' })}>{uiText("恢复预设默认色")}{' '}</Button>}
      <details className="theme-advanced">
        <summary>{uiText("高级表面色彩微调")}</summary>
        <div className="theme-custom-grid">
          {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
            <label key={key} className="theme-color-field">
              <span>{label}</span>
              <div className="theme-color-input-wrap">
                <input
                  type="color"
                  value={activeTokens[key]}
                  onChange={(e) => update({ action: 'color', key, value: e.target.value })}
                />
                <code>{activeTokens[key]}</code>
              </div>
            </label>
          ))}
        </div>
      </details>
      {children}
    </section>
  )
}
