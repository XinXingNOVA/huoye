import { useState } from 'react'
import type { UiPlugin, ViewProps, FacetProps, UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { Cond } from '@resource-manager/plugin-api/query'
import './style.css'

import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('rating')

const values = [1, 2, 3, 4, 5]

async function rate(host: UiHost, ids: string[], value: number | null) {
  try { await host.core.run('rating', 'set', { ids, value }) }
  catch (e) { host.notify(e instanceof Error ? e.message : String(e)) }
}

function RatingSection({ view, host }: ViewProps) {
  useLocale()
  const [busy, setBusy] = useState(false)
  const [hover, setHover] = useState(0)
  const value = Number(view.blocks.rating?.data.value ?? 0)
  const save = async (next: number | null) => { setBusy(true); try { await rate(host, [view.id], next) } finally { setBusy(false) } }
  return <div className="rm-rating-stars" aria-label={msg('素材评分')} onMouseLeave={() => setHover(0)}>
    <div className="rm-rating-stars-track">
      {values.map(n => (
        <button
          key={n}
          disabled={busy}
          aria-label={msg('{n} 星', { n })}
          aria-pressed={n === value}
          title={n === value ? msg('再次点击清除评分') : msg('评为 {n} 星', { n })}
          className={`${n <= value ? 'selected' : ''}${hover > 0 && n <= hover ? ' is-hover' : ''}`.trim()}
          onMouseEnter={() => setHover(n)}
          onClick={() => void save(n === value ? null : n)}
        >
          ★
        </button>
      ))}
    </div>
    <button className="rm-rating-clear" disabled={busy || !value} onClick={() => void save(null)}>{msg('清除')}</button>
  </div>
}

function isSameRatingCond(a: Cond, b: Cond): boolean {
  return (
    a.kind === b.kind &&
    a.field === b.field &&
    a.op === b.op &&
    (a.op === 'empty' ||
      (a.op === 'eq' && b.op === 'eq' && a.value === b.value) ||
      (a.op === 'range' && b.op === 'range' && a.min === b.min && a.max === b.max))
  )
}

function RatingFacet({ api }: FacetProps) {
  useLocale()
  const [hoverStar, setHoverStar] = useState(0)
  const activeList = (api.filters ?? []).filter(c => c.kind === 'rating' && c.field === 'value')
  const isActive = (cond: Cond) => activeList.some(c => isSameRatingCond(c, cond))

  const emptyCond: Cond = { op: 'empty', kind: 'rating', field: 'value' }
  const fourPlusCond: Cond = { op: 'range', kind: 'rating', field: 'value', min: 4 }
  const exactCond = activeList.find((c): c is Extract<Cond, { op: 'eq' }> => c.op === 'eq' && typeof c.value === 'number')
  const exactVal = typeof exactCond?.value === 'number' ? exactCond.value : 0
  const fourPlusActive = isActive(fourPlusCond)

  return (
    <section className="nav-group rm-rating-facet">
      <div className="nav-title rm-rating-heading">
        <span>{msg('评分')}</span>
        {activeList.length > 0 && api.toggleFilter && (
          <button
            type="button"
            className="nav-add rm-rating-reset"
            title={msg('清除评分筛选')}
            onClick={() => { for (const c of activeList) api.toggleFilter?.(c) }}
          >
            {msg('重置')}
          </button>
        )}
      </div>
      <div className="rm-rating-filters">
        <div className="rm-rating-star-bar" onMouseLeave={() => setHoverStar(0)}>
          {values.map(n => {
            const cond: Cond = { op: 'eq', kind: 'rating', field: 'value', value: n }
            const pressed = isActive(cond)
            const lit = hoverStar > 0 ? n <= hoverStar : exactVal > 0 ? n <= exactVal : fourPlusActive && n >= 4
            return (
              <button
                key={n}
                className={`rm-rating-star-btn${lit ? ' is-lit' : ''}`}
                disabled={!api.toggleFilter}
                aria-label={`${n}★`}
                aria-pressed={pressed}
                title={msg('筛选 {n} 星素材', { n })}
                onMouseEnter={() => setHoverStar(n)}
                onClick={() => api.toggleFilter?.(cond)}
              >
                ★
              </button>
            )
          })}
        </div>
        <div className="rm-rating-quick">
          <button
            className="rm-rating-chip"
            disabled={!api.toggleFilter}
            aria-pressed={fourPlusActive}
            title={msg('筛选 4 星及 5 星素材')}
            onClick={() => api.toggleFilter?.(fourPlusCond)}
          >
            {msg('4★及以上')}
          </button>
          <button
            className="rm-rating-chip"
            disabled={!api.toggleFilter}
            aria-pressed={isActive(emptyCond)}
            title={msg('筛选未评分素材')}
            onClick={() => api.toggleFilter?.(emptyCond)}
          >
            {msg('未评分')}
          </button>
        </div>
      </div>
    </section>
  )
}

export const plugin: UiPlugin = {
  id: 'rating',
  sections: [{ id: 'rating', get title() { return msg("评分") }, order: 34, kinds: ['rating'], match: (v, definitions) => !v.deletedAt && Object.keys(v.blocks).some(k => definitions.kind(k)?.content) && !Object.keys(v.blocks).some(k => definitions.kind(k)?.management), Component: RatingSection }],
  facets: [{ get title() { return msg("评分") }, kind: 'rating', field: 'value', order: 12, Component: RatingFacet }],
  badges: [{ order: 12, get: v => { const n = v.blocks.rating?.data.value; return typeof n === 'number' && n >= 1 && n <= 5 ? { text: `${n}★` } : undefined } }],
  actions: [{ id: 'rating.set', get title() { return msg("评分…") }, group: 20, order: 35, when: vs => vs.length > 0 && vs.length <= 100 && vs.every(v => !v.deletedAt), run(views, host) {
    const ids = views.map(v => v.id)
    void host.contextMenu([...values.map(n => ({ id: String(n), label: msg("{n} 星", { n }) })), { type: 'separator' }, { id: 'clear', label: msg("清除评分") }]).then(choice => { if (choice !== null) return rate(host, ids, choice === 'clear' ? null : Number(choice)) }).catch(e => host.notify(String(e)))
  } }],
  commands: [...values, 0].map(n => ({ id: `rating.set-${n}`, get title() { return n ? msg("评为 {n} 星", { n }) : msg("清除评分") }, get category() { return msg("评分") }, context: 'selection' as const,
    enabled: c => c.ids.length > 0 && c.ids.length <= 100 || msg("请选中 1～100 项素材"), run: (c, host) => rate(host, [...c.ids], n || null) }))
}
