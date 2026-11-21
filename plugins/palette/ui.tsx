import type { FacetProps, UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { useUiDocument } from '@resource-manager/plugin-api/ui/widgets'
import { FAMILIES, FAMILY_KIND, colorFamily, familyCondition } from './lib/color-families'
import './style.css'

import { pluginMessages, useLocale } from '@resource-manager/plugin-api/ui/locale'

const msg = pluginMessages('palette')

function PaletteSection({ view, host }: ViewProps) {
  useLocale()
  const document = useUiDocument()
  const raw = view.blocks.palette?.data.colors
  const colors = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
  const weights = view.blocks.palette?.data.weights
  const copy = async (hex: string) => {
    try {
      const clipboard = document.defaultView?.navigator.clipboard
      if (!clipboard) throw new Error(msg('当前窗口不支持复制色值'))
      await clipboard.writeText(hex)
      host.notify(msg('已复制 {hex}', { hex }))
    } catch (e) { host.notify(e instanceof Error ? e.message : String(e)) }
  }
  const chooseCopy = async () => {
    const choice = await host.contextMenu(colors.map((hex, index) => ({ id: String(index), label: `${hex} · ${msg(colorFamily(hex) ?? msg("未知色系"))}` })))
    if (choice !== null && colors[Number(choice)]) await copy(colors[Number(choice)])
  }
  return <div className="rm-palette-section">
    <div className="rm-palette-strip">
      {colors.map((hex, i) => {
        const family = colorFamily(hex)
        const rawWeight = Array.isArray(weights) ? weights[i] : undefined
        const weight = typeof rawWeight === 'number' && Number.isFinite(rawWeight) ? Math.max(0, Math.min(1, rawWeight)) : undefined
        return <button key={`${hex}-${i}`} className="rm-palette-swatch" disabled={!family}
          style={{ background: family ? hex : undefined, flexGrow: Math.max(weight ?? 0, 0.05) }}
          aria-label={msg('筛选{family} {hex}', { family: msg(family ?? msg("未知色系")), hex })} data-color-family={family}
          title={msg('{hex}{weight} · 点击筛选{family}；右键复制', { hex, weight: weight === undefined ? '' : ` · ${Math.round(weight * 100)}%`, family: msg(family ?? msg("未知色系")) })}
          onClick={() => { if (family) host.toggleFilter(familyCondition(family), { exclusive: true }) }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); void copy(hex) }} />
      })}
    </div>
    <button className="small" disabled={!colors.length} onClick={() => { void chooseCopy().catch(e => host.notify(String(e))) }}>{msg('复制色值…')}</button>
  </div>
}

function ColorFacet({ api, items, loading, error, reload }: FacetProps) {
  useLocale()
  const selected = api.filters?.filter(c => c.kind === FAMILY_KIND && c.field === 'values') ?? []
  return <section className="nav-group rm-palette-facet">
    <div className="nav-title rm-palette-heading">
      <span>{msg('色系')}</span>
      {selected.length > 0 && api.toggleFilter && (
        <button
          type="button"
          className="nav-add rm-palette-reset"
          title={msg('清除色系筛选')}
          onClick={() => { for (const c of selected) api.toggleFilter?.(c) }}
        >
          {msg('重置')}
        </button>
      )}
    </div>
    <div className="rm-palette-families">
      {FAMILIES.map(({ name, color }) => {
        const active = selected.some(c => c.op === 'eq' && c.value === name)
        const count = items.find(item => item.value === name)?.count ?? 0
        const empty = !loading && !error && count === 0 && !active
        return <button
          key={name}
          className={`rm-palette-family${empty ? ' is-empty' : ''}`}
          data-family={name}
          aria-pressed={active}
          aria-label={msg('{name}（{count}）', { name: msg(name), count })}
          disabled={!api.toggleFilter}
          title={msg('{name}（{count}）：色板中含此色系；普通点击切换，⌘/Ctrl 点击叠加（同时包含）', { name: msg(name), count })}
          onClick={e => api.toggleFilter?.(familyCondition(name), { exclusive: !e.metaKey && !e.ctrlKey })}
        >
          <span aria-hidden="true" className="rm-palette-dot" style={{ background: color }} />
          <span className="rm-palette-sr">{msg(name)}</span>
          {active ? (
            <span aria-hidden="true" className="rm-palette-mark">✓</span>
          ) : (
            !loading && !error && count > 0 && <small className="rm-palette-count">{count}</small>
          )}
        </button>
      })}
    </div>
    {loading && !items.length && <div className="nav-hint muted" role="status">{msg('正在统计…')}</div>}
    {error && <div className="nav-hint" role="alert">{msg('色系统计失败')} <button className="link" title={error} onClick={reload}>{msg('重试')}</button></div>}
  </section>
}

export const plugin: UiPlugin = {
  id: 'palette',
  sections: [{ id: 'palette', get title() { return msg("色板") }, order: 30, kinds: ['palette'], match: v => !!v.blocks.palette, Component: PaletteSection }],
  facets: [{ get title() { return msg("色系") }, kind: FAMILY_KIND, field: 'values', order: 11, Component: ColorFacet }]
}
