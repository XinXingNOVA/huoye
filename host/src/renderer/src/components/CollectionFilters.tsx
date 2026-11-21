import { t, useLanguage } from '../language'
import { useEffect, useMemo, useState } from 'react'
import type { FacetItem, Query } from '../../../shared/query'
import type { FacetDef, TabApi, UiHost, ToolViewProps, CollectionFilterCapability } from '../plugin'
import { facetsFor, useKinds } from '../ui-registry'

export function CollectionFilters({ host, active, context }: ToolViewProps) {
  useLanguage()
  const kinds = useKinds(), facets = useMemo(() => facetsFor(kinds), [kinds])
  const api = context?.capabilities['collection.filter'] as CollectionFilterCapability | undefined
  if (!api) return null
  return <div className="collection-filters" data-filter-page={context?.pageId}>
    {facets.map(f => <Facet key={f.id ?? `${f.kind}.${f.field}`} host={host} facet={f} api={api} active={active} />)}
    {!facets.length && <p className="muted">{t('detail.noFields')}</p>}
  </div>
}

function Facet({ host, facet, api, active: shown }: { host: UiHost; facet: FacetDef; api: TabApi; active: boolean }) {
  useLanguage()
  const { kind, field, Component } = facet
  const title = kind === 'file' && field === 'ext' ? t('schema.extension') : facet.title
  const queryKey = JSON.stringify(facet.source !== 'blocks' ? api.facetQuery?.(facet.kind, facet.field) : undefined)
  // 以查询值而非回调身份订阅；点选本分面的值、选择素材或调整排序不重复请求。
  const scope = useMemo(() => ({ host, kind, field, query: queryKey ? JSON.parse(queryKey) as Query : undefined }), [host, kind, field, queryKey])
  const [state, setState] = useState<{ scope: typeof scope; items: FacetItem[]; loading: boolean; error?: string }>()
  const [revision, setRevision] = useState(0)
  const [filterText, setFilterText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const customOnly = facet.source === 'blocks'
  useEffect(() => {
    if (!shown || customOnly || scope.kind === undefined || scope.field === undefined) return
    const { kind, field } = scope
    let alive = true, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      const ticket = ++generation
      setState(previous => ({ scope, items: previous?.scope === scope ? previous.items : [], loading: true }))
      try {
        const items = await scope.host.core.facet(kind, field, { query: scope.query })
        if (alive && ticket === generation) setState({ scope, items, loading: false })
      } catch (error) {
        if (alive && ticket === generation) setState(previous => ({ scope, items: previous?.scope === scope ? previous.items : [], loading: false, error: String(error) }))
      }
    }
    void run()
    const off = host.core.on('listChanged', () => {
      ++generation
      clearTimeout(timer)
      timer = setTimeout(() => void run(), 150)
    })
    return () => { alive = false; clearTimeout(timer); off() }
  }, [scope, revision, shown, customOnly])
  // 切换范围的当次渲染即移除旧结果；迟到请求不能覆盖新页面。
  const current = state?.scope === scope ? state : undefined
  const items = current?.items ?? [], loading = customOnly ? false : (current?.loading ?? true), error = current?.error
  const reload = () => setRevision(value => value + 1)
  if (Component) return <Component active={shown} host={host} facet={facet} items={items} api={api} loading={loading} error={error} reload={reload} />
  if (kind === undefined || field === undefined) return null
  const visible = new Map(items.map(item => [item.value, item]))
  for (const c of api.filters ?? []) if (c.op === 'eq' && c.kind === kind && c.field === field && typeof c.value === 'string' && !visible.has(c.value)) visible.set(c.value, { value: c.value, count: 0 })
  if (!visible.size && !loading && !error) return null
  const active = (value: string) =>
    api.filters?.some((c) => c.op === 'eq' && c.kind === kind && c.field === field && c.value === value) ?? false

  const allItems = [...visible.values()]
  const keyword = filterText.trim().toLowerCase()
  const filteredItems = keyword
    ? allItems.filter((it) => active(it.value) || (it.value || t('detail.noValue')).toLowerCase().includes(keyword))
    : allItems
  const limit = 24
  const displayedItems = !keyword && !expanded && filteredItems.length > limit
    ? filteredItems.filter((it, idx) => idx < limit || active(it.value))
    : filteredItems

  return (
    <div className="nav-group facet-group">
      <div className="nav-title">{title}</div>
      {allItems.length > 10 && (
        <div className="facet-filter-row">
          <input
            className="facet-filter-input"
            type="search"
            placeholder={t('detail.filterBy', { title })}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      )}
      {loading && !items.length && <div className="nav-hint muted" role="status">{t('detail.pendingRead')}</div>}
      {error && <div className="nav-hint" role="alert">{t('detail.failed')} <button className="link" title={error} onClick={reload}>{t('detail.retry')}</button></div>}
      <div className="facet-pill-flow">
        {displayedItems.map((it) => (
          <button
            key={it.value}
            className={`nav-item facet-pill${active(it.value) ? ' active' : ''}`}
            onClick={() => api.toggleFilter?.({ op: 'eq', kind, field, value: it.value })}
          >
            <span className="nav-label">{it.value || t('detail.noValue')}</span>
            <span className="nav-count">{it.count}</span>
          </button>
        ))}
      </div>
      {!keyword && filteredItems.length > limit && (
        <button className="facet-more-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('detail.collapse') : t('detail.expand', { count: filteredItems.length })}
        </button>
      )}
    </div>
  )
}

