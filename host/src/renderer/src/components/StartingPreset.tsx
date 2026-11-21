import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { t, useLanguage } from '../language'
import { findTheme, themeDisplayName } from '../theme'
import { useMemo, useState } from 'react'
import type { PluginPreset } from '../../../shared/plugin-presets'
import type { WorkbenchLayout, WorkbenchNode } from '../../../shared/workbench-layout'

import type { StartingPresetModel, StartingChoice } from './use-starting-preset'

interface Props {
  model: StartingPresetModel
  value: StartingChoice
  disabled: boolean
  onChange(value: StartingChoice): void
  onInstall(): void
}

function surfaceLabel(type: string, target: Record<string, unknown>, presentation?: Record<string, unknown>) {
  const layoutMap: Record<string, string> = { masonry: t('workbench.masonry'), grid: t('create.grid'), table: t('create.table'), kanban: t('create.kanban'), timeline: t('create.timeline') }
  const mode = typeof presentation?.layout === 'string' ? layoutMap[presentation.layout] ?? presentation.layout : undefined
  if (type === 'collection') {
    const viewName = target.presetId === 'all' ? t('create.contents') : target.presetId === 'trash' ? t('common.trash') : t('create.collection')
    return mode ? `${viewName} · ${mode}` : viewName
  }
  if (type === 'file-spaces') return t('common.fileSpaces')
  if (type === 'history') return t('create.history')
  if (type === 'management') return t('create.management')
  return type
}

function MiniLayoutNode({ node, layout }: { node: WorkbenchNode; layout: WorkbenchLayout }) {
  useUiLocale()
  if (node.type === 'group') {
    const isPrimary = node.id === layout.primary
    const items = layout.contents?.[node.id]?.items ?? []
    const activeIdx = layout.contents?.[node.id]?.active ?? 0
    const primaryItem = items[activeIdx] ?? items[0]
    const label = primaryItem
      ? primaryItem.kind === 'page'
        ? surfaceLabel(primaryItem.type, primaryItem.target, primaryItem.presentation)
        : uiText("工具 · {id}", { id: String(primaryItem.id) })
      : isPrimary
        ? t('create.primaryArea')
        : t('create.secondaryArea')
    return (
      <div className={`starting-mini-slot${isPrimary ? ' is-primary' : ''}`}>
        <span className="starting-mini-slot-title">{label}</span>
        {isPrimary && <small className="starting-mini-slot-tag">{t('create.primary')}</small>}
      </div>
    )
  }
  return (
    <div className="starting-mini-split" data-direction={node.direction}>
      <div style={{ flex: `${node.ratio} 1 0%` }}>
        <MiniLayoutNode node={node.first} layout={layout} />
      </div>
      <div style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <MiniLayoutNode node={node.second} layout={layout} />
      </div>
    </div>
  )
}

function MiniWorkbenchDiagram({ layout }: { layout?: WorkbenchLayout }) {
  if (!layout) {
    return (
      <div className="starting-mini-diagram" aria-hidden="true">
        <div className="starting-mini-side">{t('create.leftTools')}</div>
        <div className="starting-mini-slot is-primary">
          <span className="starting-mini-slot-title">{t('create.standardArea')}</span>
          <small className="starting-mini-slot-tag">{t('create.default')}</small>
        </div>
        <div className="starting-mini-side">{t('create.rightDetails')}</div>
      </div>
    )
  }
  return (
    <div className="starting-mini-diagram" aria-hidden="true">
      {layout.panels.sidebar && <div className="starting-mini-side">{t('create.left')}</div>}
      <div className="starting-mini-center">
        <MiniLayoutNode node={layout.root} layout={layout} />
      </div>
      {layout.panels.inspector && <div className="starting-mini-side">{t('create.right')}</div>}
    </div>
  )
}

/** 开始页仅展示静态预演；不启动插件，也不持有仓库或布局状态。 */
export function StartingPreset({ model, value, disabled, onChange, onInstall }: Props) {
  useLanguage()
  const { presets, selected, preview, error } = model
  const recommendedTheme = selected?.recommendedTheme ? findTheme(selected.recommendedTheme) : undefined
  const [versionsOpen, setVersionsOpen] = useState(false)
  const { id, versions, layout } = value
  const onSelect = (id: string) => { if (id !== value.id) onChange({ id, versions: [], layout: true }) }
  const suiteGroups = useMemo(() => {
    const map = new Map<string, { title: string; items: PluginPreset[] }>()
    for (const p of presets) {
      if (p.source?.kind === 'suite') {
        const key = p.source.id
        const existing = map.get(key)
        if (existing) existing.items.push(p)
        else map.set(key, { title: p.source.title, items: [p] })
      }
    }
    return [...map.entries()]
  }, [presets])

  const userPresets = useMemo(() => presets.filter(p => p.source?.kind !== 'suite'), [presets])
  const externalCount = preview?.selection.external.filter(p => p.enabled).length ?? 0

  return (
    <div className="starting-preset">
      <div className="starting-preset-header">
        <div className="starting-preset-heading">
          <span className="muted starting-preset-subtitle">{t('create.featuresHint')}</span>
        </div>
        <div className="starting-preset-toolbar">
          <button className="small" disabled={disabled} onClick={onInstall}>
            {t('create.installSuite')}
          </button>
        </div>
      </div>

      {presets.length > 0 ? (
        <div className="starting-master-detail">
          <nav className="starting-catalog" aria-label={t('create.groups')}>
            <div className="starting-catalog-group">
              <div className="starting-catalog-group-title">{t('create.system')}</div>
              <button
                type="button"
                className={`starting-nav-item${!id ? ' active' : ''}`}
                aria-pressed={!id}
                disabled={disabled}
                onClick={() => onSelect('')}
              >
                <span className="starting-nav-item-name">{t('create.blank')}</span>
                <span className="starting-nav-item-meta">{t('create.essentials')}</span>
              </button>
            </div>

            {suiteGroups.map(([suiteId, group]) => (
              <div className="starting-catalog-group" key={suiteId}>
                <div className="starting-catalog-group-title">
                  <span>{t('create.suite')} {group.title}</span>
                  <span>{group.items.length}</span>
                </div>
                {group.items.map(p => (
                  <button
                    type="button"
                    key={p.id}
                    className={`starting-nav-item${id === p.id ? ' active' : ''}`}
                    aria-pressed={id === p.id}
                    disabled={disabled}
                    onClick={() => onSelect(p.id)}
                  >
                    <span className="starting-nav-item-name">{p.title}</span>
                    <span className="starting-nav-item-meta">{p.layout ? t('create.withLayout') : uiText("{length} 项", { length: String(p.plugins.length) })}</span>
                  </button>
                ))}
              </div>
            ))}

            {userPresets.length > 0 && (
              <div className="starting-catalog-group">
                <div className="starting-catalog-group-title">
                  <span>{t('create.mine')}</span>
                  <span>{userPresets.length}</span>
                </div>
                {userPresets.map(p => (
                  <button
                    type="button"
                    key={p.id}
                    className={`starting-nav-item${id === p.id ? ' active' : ''}`}
                    aria-pressed={id === p.id}
                    disabled={disabled}
                    onClick={() => onSelect(p.id)}
                  >
                    <span className="starting-nav-item-name">{p.title}</span>
                    <span className="starting-nav-item-meta">{p.layout ? t('create.withLayout') : uiText("{length} 项", { length: String(p.plugins.length) })}</span>
                  </button>
                ))}
              </div>
            )}
          </nav>

          <div className="starting-spotlight">
            <div className="starting-spotlight-top">
              <div className="starting-spotlight-head">
                <div className="starting-spotlight-title-row">
                  <strong>{selected ? selected.title : t('create.blank')}</strong>
                  <span className="starting-source-badge">
                    {selected
                      ? selected.source?.kind === 'suite'
                        ? selected.source.title
                        : t('create.mine')
                      : t('create.systemDefault')}
                  </span>
                </div>
                <p className="muted starting-spotlight-desc">
                  {selected?.description ||
                    (selected
                      ? uiText("启用方案指定的 {length} 项功能，首次进入仓库直接就位。", { length: String(selected.plugins.length) })
                      : t('create.blankHint'))}
                </p>
              </div>

              {selected?.recommendedTheme && <span className="muted">{t('create.suggestedTheme')} {recommendedTheme ? themeDisplayName(recommendedTheme) : t('create.followTheme')}</span>}
              <MiniWorkbenchDiagram layout={selected && layout ? selected.layout : undefined} />

              {!!selected?.plugins.length && (
                <div className="starting-plugin-pills">
                  <span className="muted">{t('create.features')}</span>
                  {selected.plugins.map(p => (
                    <span key={p.id} className="starting-plugin-pill">
                      {p.title}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="starting-spotlight-foot">
              {selected?.layout && (
                <label className="starting-layout">
                  <input
                    type="checkbox"
                    checked={layout}
                    disabled={disabled}
                    onChange={e => onChange({ ...value, layout: e.target.checked })}
                  />
                  {t('create.useLayout')}
                </label>
              )}

              {preview && (
                <details className="starting-preview" open={preview.issues.length > 0 || versionsOpen} onToggle={e => setVersionsOpen(e.currentTarget.open)}>
                  <summary>
                    {selected ? selected.title : t('create.essentials')} · {externalCount}{' '}{uiText("个外部插件")}{' '}{selected?.layout && layout ? uiText(" · 含工作台安排") : ''}
                  </summary>
                  {preview.versions.map(p => (
                    <label className="starting-version" key={p.id}>
                      <span>{p.title}</span>
                      <select
                        aria-label={p.title + uiText("版本")}
                        disabled={disabled}
                        value={versions.find(v => v.id === p.id)?.hash ?? ''}
                        onChange={e => {
                          const hash = e.target.value
                          onChange({ ...value, versions: [
                            ...versions.filter(v => v.id !== p.id),
                            ...(hash ? [{ id: p.id, hash, enabled: true }] : [])
                          ] })
                        }}
                      >
                        <option value="">{t('create.recommend')}</option>
                        {p.choices.map(v => (
                          <option key={v.hash} value={v.hash}>
                            {v.version} · {v.hash.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  {preview.warnings.map(w => (
                    <p className="muted" key={w}>
                      {w}
                    </p>
                  ))}
                  {preview.issues.map(i => (
                    <p className="package-error" key={i}>
                      {i}
                    </p>
                  ))}
                  {selected?.layout && layout && (
                    <p className="muted">{uiText("包含侧栏安排")}{selected.layout.root.type === 'split' ? uiText("与分屏") : ''}{uiText("；内容入口将在所需插件启动后核验。")}{' '}</p>
                  )}
                </details>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="starting-empty-box">
          <div className="starting-empty-main">
            <strong>{uiText("空白底座（标准工作台）")}</strong>
            <span className="muted">{uiText("安装")}{' '}<code>.hysuite</code>{' '}{uiText("套件或在仓库设置中保存组合后，可在此直接按方案创建仓库。")}{' '}</span>
          </div>
          {preview && (
            <details className="starting-preview" open={!!preview.issues.length}>
              <summary>{uiText("核心功能 ·")}{' '}{externalCount}{' '}{uiText("个外部插件")}</summary>
              {preview.warnings.map(w => (
                <p className="muted" key={w}>
                  {w}
                </p>
              ))}
              {preview.issues.map(i => (
                <p className="package-error" key={i}>
                  {i}
                </p>
              ))}
            </details>
          )}
        </div>
      )}

      {!preview && !error && <p role="status" className="muted">{t('create.checking')}</p>}
      {error && (
        <p role="alert" className="package-error">
          {error}
        </p>
      )}
    </div>
  )
}
