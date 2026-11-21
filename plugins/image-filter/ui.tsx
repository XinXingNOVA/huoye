import { useState, type ReactNode } from 'react'
import type { UiPlugin, FacetProps } from '@resource-manager/plugin-api/ui/contracts'
import type { Cond } from '@resource-manager/plugin-api/query'
import { SHAPES, parseRange } from './model'
import './style.css'

import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('image-filter')

const SHAPE_ICONS: Record<(typeof SHAPES)[number], ReactNode> = {
  方图: <rect x="3" y="2" width="10" height="10" rx="1.5" />,
  横图: <rect x="1.5" y="3.5" width="13" height="7" rx="1.5" />,
  竖图: <rect x="4.5" y="1" width="7" height="12" rx="1.5" />,
  长横图: <rect x="1" y="5" width="14" height="4" rx="1" />,
  长竖图: <rect x="6" y="1" width="4" height="12" rx="1" />
}

function ShapeFacet({ api, items, loading, error, reload }: FacetProps) {
  useLocale()
  const activeShapes = (api.filters ?? []).filter(
    c => c.kind === 'image-filter.geometry' && c.field === 'shape'
  )
  return (
    <section className="nav-group rm-image-filter-facet rm-image-filter-shape-facet">
      <div className="nav-title rm-image-filter-heading">
        <span>{msg('画幅')}</span>
        {activeShapes.length > 0 && api.toggleFilter && (
          <button
            type="button"
            className="nav-add rm-image-filter-reset"
            title={msg('清除画幅筛选')}
            onClick={() => { for (const c of activeShapes) api.toggleFilter?.(c) }}
          >
            {msg('重置')}
          </button>
        )}
      </div>
      <div className="rm-image-filter-pills">
        {SHAPES.map(shape => {
          const selected = activeShapes.some(c => c.op === 'eq' && c.value === shape)
          const count = items.find(i => i.value === shape)?.count ?? 0
          const empty = !loading && !error && count === 0 && !selected
          return (
            <button
              key={shape}
              className={`rm-shape-pill${empty ? ' is-empty' : ''}`}
              title={msg('{shape}（{count}）：方图为等宽高；长图长短边比至少 3:1，各类互斥', { shape: msg(shape), count })}
              aria-pressed={selected}
              disabled={!api.toggleFilter}
              onClick={() =>
                api.toggleFilter?.({
                  op: 'eq',
                  kind: 'image-filter.geometry',
                  field: 'shape',
                  value: shape
                })
              }
            >
              <svg
                className="rm-shape-icon"
                viewBox="0 0 16 14"
                width="14"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden="true"
              >
                {SHAPE_ICONS[shape]}
              </svg>
              <span className="rm-shape-label">{msg(shape)}</span>
              {!loading && !error && count > 0 && <small className="rm-shape-count">{count}</small>}
            </button>
          )
        })}
      </div>
      {error && (
        <div className="nav-hint" role="alert">
          {msg('统计失败')} <button className="link" onClick={reload}>{msg('重试')}</button>
        </div>
      )}
    </section>
  )
}

const DIMENSION_AXES = [
  { get title() { return msg("长边") }, kind: 'image-filter.geometry', field: 'longSide' },
  { get title() { return msg("宽度") }, kind: 'image', field: 'width' },
  { get title() { return msg("高度") }, kind: 'image', field: 'height' }
] as const

function DimensionsFacet({ api, facet }: FacetProps) {
  useLocale()
  if (facet.source === 'blocks') return null
  const activeRanges = (api.filters ?? []).filter(c =>
    DIMENSION_AXES.some(axis => c.kind === axis.kind && c.field === axis.field)
  )

  // 筛选来源变化时重建输入草稿，不在用户输入中途用查询结果覆盖。
  return (
    <section className="nav-group rm-image-filter-facet rm-image-filter-range-facet">
      <div className="nav-title rm-image-filter-heading">
        <span>{msg('尺寸 (px)')}</span>
        {activeRanges.length > 0 && api.toggleFilter && (
          <button
            type="button"
            className="nav-add rm-image-filter-reset"
            title={msg('清除全部尺寸筛选')}
            onClick={() => { for (const c of activeRanges) api.toggleFilter?.(c) }}
          >
            {msg('重置')}
          </button>
        )}
      </div>
      <div className="rm-image-filter-axes">
        {DIMENSION_AXES.map(axis => {
          const current = api.filters?.find(c => c.kind === axis.kind && c.field === axis.field)
          return (
            <RangeEditor
              key={JSON.stringify([axis.kind, axis.field, current])}
              api={api}
              kind={axis.kind}
              field={axis.field}
              title={msg(axis.title)}
              current={current}
            />
          )
        })}
      </div>
    </section>
  )
}

function RangeEditor({
  api,
  kind,
  field,
  title,
  current
}: {
  api: FacetProps['api']
  kind: string
  field: string
  title: string
  current?: Cond
}) {
  useLocale()
  const [min, setMin] = useState(current?.op === 'range' ? String(current.min ?? '') : '')
  const [max, setMax] = useState(current?.op === 'range' ? String(current.max ?? '') : '')
  const [error, setError] = useState('')
  const apply = (low: string, high: string) => {
    try {
      const range = parseRange(low, high)
      if (range.min === undefined && range.max === undefined) {
        if (current) api.toggleFilter?.(current)
        setMin('')
        setMax('')
      } else {
        const next: Cond = { op: 'range', kind, field, ...range }
        if (!(current?.op === 'range' && current.min === range.min && current.max === range.max))
          api.toggleFilter?.(next)
      }
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <form
      className="rm-image-filter-range"
      onSubmit={e => {
        e.preventDefault()
        apply(min, max)
      }}
    >
      <div className="rm-range-row">
        <span className={`rm-range-axis${current ? ' is-active' : ''}`}>{title}</span>
        <div className={`rm-range-box${current ? ' is-active' : ''}`}>
          <input
            aria-label={msg('{title}最小像素', { title })}
            type="number"
            min="1"
            step="1"
            placeholder={msg('最小')}
            value={min}
            onChange={e => setMin(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
          />
          <span className="rm-range-sep">–</span>
          <input
            aria-label={msg('{title}最大像素', { title })}
            type="number"
            min="1"
            step="1"
            placeholder={msg('最大')}
            value={max}
            onChange={e => setMax(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
          />
        </div>
        <button
          className="rm-range-apply"
          disabled={!api.toggleFilter}
          type="submit"
          title={msg('应用{title}像素范围', { title })}
        >
          {msg('应用')}
        </button>
        <button
          className="rm-range-clear"
          disabled={!api.toggleFilter || !current}
          type="button"
          title={msg('清除{title}范围', { title })}
          aria-label={msg('清除{title}范围', { title })}
          onClick={() => apply('', '')}
        >
          ×
        </button>
      </div>
      {kind === 'image-filter.geometry' && (
        <div className="rm-range-presets">
          <span className="rm-range-axis rm-range-presets-label">{msg('常用')}</span>
          <div className="rm-range-presets-grid">
            {[1080, 2160, 3840].map(n => {
              const activePreset =
                current?.op === 'range' && current.min === n && current.max === undefined
              return (
                <button
                  key={n}
                  className={`rm-range-preset${activePreset ? ' is-active' : ''}`}
                  disabled={!api.toggleFilter}
                  type="button"
                  onClick={() => apply(activePreset ? '' : String(n), '')}
                >
                  ≥{n}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {error && <small role="alert">{msg(error)}</small>}
    </form>
  )
}

export const plugin: UiPlugin = {
  id: 'image-filter',
  facets: [
    { get title() { return msg("画幅") }, kind: 'image-filter.geometry', field: 'shape', order: 13, Component: ShapeFacet },
    { get title() { return msg("尺寸") }, kind: 'image-filter.geometry', field: 'longSide', order: 14, Component: DimensionsFacet }
  ]
}
