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
  const layoutMap: Record<string, string> = { masonry: '瀑布流', grid: '网格', table: '表格', kanban: '看板', timeline: '时间线' }
  const mode = typeof presentation?.layout === 'string' ? layoutMap[presentation.layout] ?? presentation.layout : undefined
  if (type === 'collection') {
    const viewName = target.presetId === 'all' ? '全部素材' : target.presetId === 'trash' ? '回收站' : '集合视图'
    return mode ? `${viewName} · ${mode}` : viewName
  }
  if (type === 'file-spaces') return '文件空间'
  if (type === 'history') return '操作历史'
  if (type === 'management') return '管理数据'
  return type
}

function MiniLayoutNode({ node, layout }: { node: WorkbenchNode; layout: WorkbenchLayout }) {
  if (node.type === 'group') {
    const isPrimary = node.id === layout.primary
    const items = layout.contents?.[node.id]?.items ?? []
    const activeIdx = layout.contents?.[node.id]?.active ?? 0
    const primaryItem = items[activeIdx] ?? items[0]
    const label = primaryItem
      ? primaryItem.kind === 'page'
        ? surfaceLabel(primaryItem.type, primaryItem.target, primaryItem.presentation)
        : `工具 · ${primaryItem.id}`
      : isPrimary
        ? '主工作区'
        : '对照分区'
    return (
      <div className={`starting-mini-slot${isPrimary ? ' is-primary' : ''}`}>
        <span className="starting-mini-slot-title">{label}</span>
        {isPrimary && <small className="starting-mini-slot-tag">主区</small>}
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
        <div className="starting-mini-side">左栏 · 导航与筛选</div>
        <div className="starting-mini-slot is-primary">
          <span className="starting-mini-slot-title">主工作区（标准整理）</span>
          <small className="starting-mini-slot-tag">默认</small>
        </div>
        <div className="starting-mini-side">右栏 · 检查器</div>
      </div>
    )
  }
  return (
    <div className="starting-mini-diagram" aria-hidden="true">
      {layout.panels.sidebar && <div className="starting-mini-side">左栏</div>}
      <div className="starting-mini-center">
        <MiniLayoutNode node={layout.root} layout={layout} />
      </div>
      {layout.panels.inspector && <div className="starting-mini-side">右栏</div>}
    </div>
  )
}

/** 开始页仅展示静态预演；不启动插件，也不持有仓库或布局状态。 */
export function StartingPreset({ model, value, disabled, onChange, onInstall }: Props) {
  const { presets, selected, preview, error } = model
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
          <span className="muted starting-preset-subtitle">决定新仓库初始启用的插件能力与工作台安排</span>
        </div>
        <div className="starting-preset-toolbar">
          <button className="small" disabled={disabled} onClick={onInstall}>
            安装套件…
          </button>
        </div>
      </div>

      {presets.length > 0 ? (
        <div className="starting-master-detail">
          <nav className="starting-catalog" aria-label="起始方案分组列表">
            <div className="starting-catalog-group">
              <div className="starting-catalog-group-title">系统基础</div>
              <button
                type="button"
                className={`starting-nav-item${!id ? ' active' : ''}`}
                aria-pressed={!id}
                disabled={disabled}
                onClick={() => onSelect('')}
              >
                <span className="starting-nav-item-name">空白底座</span>
                <span className="starting-nav-item-meta">核心功能</span>
              </button>
            </div>

            {suiteGroups.map(([suiteId, group]) => (
              <div className="starting-catalog-group" key={suiteId}>
                <div className="starting-catalog-group-title">
                  <span>套件 · {group.title}</span>
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
                    <span className="starting-nav-item-meta">{p.layout ? '含布局' : `${p.plugins.length} 项`}</span>
                  </button>
                ))}
              </div>
            ))}

            {userPresets.length > 0 && (
              <div className="starting-catalog-group">
                <div className="starting-catalog-group-title">
                  <span>我的组合</span>
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
                    <span className="starting-nav-item-meta">{p.layout ? '含布局' : `${p.plugins.length} 项`}</span>
                  </button>
                ))}
              </div>
            )}
          </nav>

          <div className="starting-spotlight">
            <div className="starting-spotlight-top">
              <div className="starting-spotlight-head">
                <div className="starting-spotlight-title-row">
                  <strong>{selected ? selected.title : '空白底座'}</strong>
                  <span className="starting-source-badge">
                    {selected
                      ? selected.source?.kind === 'suite'
                        ? selected.source.title
                        : '我的组合'
                      : '系统默认'}
                  </span>
                </div>
                <p className="muted starting-spotlight-desc">
                  {selected?.description ||
                    (selected
                      ? `启用方案指定的 ${selected.plugins.length} 项功能，首次进入仓库直接就位。`
                      : '仅启用核心功能，之后可按需添加插件。')}
                </p>
              </div>

              <MiniWorkbenchDiagram layout={selected && layout ? selected.layout : undefined} />

              {!!selected?.plugins.length && (
                <div className="starting-plugin-pills">
                  <span className="muted">方案功能：</span>
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
                  应用配套工作台安排
                </label>
              )}

              {preview && (
                <details className="starting-preview" open={preview.issues.length > 0 || versionsOpen} onToggle={e => setVersionsOpen(e.currentTarget.open)}>
                  <summary>
                    {selected ? selected.title : '核心功能'} · {externalCount} 个外部插件
                    {selected?.layout && layout ? ' · 含工作台安排' : ''}
                  </summary>
                  {preview.versions.map(p => (
                    <label className="starting-version" key={p.id}>
                      <span>{p.title}</span>
                      <select
                        aria-label={p.title + '版本'}
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
                        <option value="">按方案推荐／自动选择</option>
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
                    <p className="muted">
                      包含侧栏安排{selected.layout.root.type === 'split' ? '与分屏' : ''}；内容入口将在所需插件启动后核验。
                    </p>
                  )}
                </details>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="starting-empty-box">
          <div className="starting-empty-main">
            <strong>空白底座（标准工作台）</strong>
            <span className="muted">
              安装 <code>.hysuite</code> 套件或在仓库设置中保存组合后，可在此直接按方案创建仓库。
            </span>
          </div>
          {preview && (
            <details className="starting-preview" open={!!preview.issues.length}>
              <summary>核心功能 · {externalCount} 个外部插件</summary>
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

      {!preview && !error && <p role="status" className="muted">正在检查方案…</p>}
      {error && (
        <p role="alert" className="package-error">
          {error}
        </p>
      )}
    </div>
  )
}
