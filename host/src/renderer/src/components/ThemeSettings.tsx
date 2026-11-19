import { ACCENT_SWATCHES, THEME_PRESETS, resolveThemeTokens, useThemePreferences, type ThemeTokens } from '../theme'
import { SectionHeader, SettingGroup, SettingRow } from './ui-primitives'

const CUSTOM_COLOR_FIELDS: { key: keyof NonNullable<ReturnType<typeof useThemePreferences>[0]['customTokens']>; label: string }[] = [
  { key: 'shell', label: '外框壳层' },
  { key: 'panel', label: '侧栏与检查器' },
  { key: 'bg', label: '主画布背景' },
  { key: 'text', label: '主文字' },
  { key: 'paper', label: '阅读纸张' }
]

export function ThemeSettings() {
  const [prefs, setPrefs] = useThemePreferences()
  const activeTokens = resolveThemeTokens(prefs)
  const hasCustom = !!(prefs.accent || (prefs.customTokens && Object.keys(prefs.customTokens).length > 0))

  const updateCustomToken = (key: keyof Partial<Pick<ThemeTokens, 'bg' | 'panel' | 'shell' | 'text' | 'accent' | 'paper'>>, value: string) => {
    setPrefs({
      ...prefs,
      customTokens: { ...(prefs.customTokens ?? {}), [key]: value }
    })
  }

  return (
    <section className="theme-settings" aria-label="外观与主题">
      <SectionHeader
        title="外观与主题"
        subtitle="实时切换工作台色彩层次、强调色与空间密度。"
        actions={
          hasCustom ? (
            <button
              className="small"
              onClick={() => setPrefs({ ...prefs, accent: undefined, customTokens: undefined })}
            >
              恢复预设默认色
            </button>
          ) : undefined
        }
      />

      <div className="theme-group">
        <h3>主题预设</h3>
        <div className="theme-preset-grid">
          {THEME_PRESETS.map((preset) => {
            const active = prefs.presetId === preset.id
            const t = preset.tokens
            return (
              <button
                key={preset.id}
                type="button"
                className={`theme-preset-card${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => setPrefs({ ...prefs, presetId: preset.id, customTokens: undefined })}
              >
                <div className="theme-preview-mini" style={{ background: t.shell, borderColor: t.line }}>
                  <div className="theme-preview-sidebar" style={{ background: t.panel, borderRightColor: t.line }}>
                    <span style={{ background: t.accent }} />
                    <span style={{ background: t.panel2 }} />
                  </div>
                  <div className="theme-preview-canvas" style={{ background: t.bg }}>
                    <div className="theme-preview-card" style={{ background: t.paper }} />
                    <div className="theme-preview-card" style={{ background: t.panel2 }} />
                  </div>
                  <div className="theme-preview-inspector" style={{ background: t.panel, borderLeftColor: t.line }} />
                </div>
                <div className="theme-preset-meta">
                  <div className="theme-preset-title">
                    <strong>{preset.name}</strong>
                    <span className="theme-scheme-badge">{t.scheme === 'light' ? '浅色' : '深色'}</span>
                  </div>
                  <p className="muted">{preset.description}</p>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <SettingGroup title="界面细节">
        <SettingRow title="强调色" description="用于高亮选中项、主操作按钮与活动指示">
          <div className="theme-swatches">
            {ACCENT_SWATCHES.map((s) => {
              const current = activeTokens.accent.toLowerCase() === s.value.toLowerCase()
              return (
                <button
                  key={s.value}
                  type="button"
                  className={`theme-swatch-btn${current ? ' active' : ''}`}
                  title={s.name}
                  aria-label={`强调色：${s.name}`}
                  aria-pressed={current}
                  onClick={() => setPrefs({ ...prefs, accent: s.value })}
                >
                  <span className="theme-swatch-dot" style={{ background: s.value }} />
                  <span>{s.name}</span>
                </button>
              )
            })}
            <label className="theme-custom-color" title="自定义强调色">
              <input
                type="color"
                value={activeTokens.accent}
                onChange={(e) => setPrefs({ ...prefs, accent: e.target.value })}
              />
              <span className="muted">自定义</span>
            </label>
          </div>
        </SettingRow>

        <SettingRow title="界面密度" description="调整列表、侧栏与检查器的内边距">
          <div className="segmented">
            <button
              type="button"
              className={prefs.density === 'comfortable' ? 'on' : ''}
              onClick={() => setPrefs({ ...prefs, density: 'comfortable' })}
            >
              舒展
            </button>
            <button
              type="button"
              className={prefs.density === 'compact' ? 'on' : ''}
              onClick={() => setPrefs({ ...prefs, density: 'compact' })}
            >
              紧凑
            </button>
          </div>
        </SettingRow>

        <SettingRow title="控件圆角" description="调整卡片、输入框与按钮的圆角风格">
          <div className="segmented">
            <button
              type="button"
              className={prefs.radius === 'sharp' ? 'on' : ''}
              onClick={() => setPrefs({ ...prefs, radius: 'sharp' })}
            >
              利落
            </button>
            <button
              type="button"
              className={prefs.radius === 'rounded' ? 'on' : ''}
              onClick={() => setPrefs({ ...prefs, radius: 'rounded' })}
            >
              标准
            </button>
            <button
              type="button"
              className={prefs.radius === 'soft' ? 'on' : ''}
              onClick={() => setPrefs({ ...prefs, radius: 'soft' })}
            >
              柔和
            </button>
          </div>
        </SettingRow>
      </SettingGroup>

      <details className="theme-advanced">
        <summary>高级表面色彩微调</summary>
        <div className="theme-custom-grid">
          {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
            <label key={key} className="theme-color-field">
              <span>{label}</span>
              <div className="theme-color-input-wrap">
                <input
                  type="color"
                  value={activeTokens[key]}
                  onChange={(e) => updateCustomToken(key, e.target.value)}
                />
                <code>{activeTokens[key]}</code>
              </div>
            </label>
          ))}
        </div>
      </details>
    </section>
  )
}
