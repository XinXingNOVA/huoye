import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import './timeline.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LayoutOptionsProps, LayoutProps, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { ResourceCard } from '@resource-manager/plugin-api/ui/media'
import { arrange, groupItems, readCollapsed, readOptions, rowAt } from './model'

const uiText = packageMessages('timeline')


function Timeline(props: LayoutProps) {
  const locale = useUiLocale()
  const { ids, host, options, zoom, state, anchor, visible, selection, onState, onAnchor, onPointer, onOpen, dragIds, onBackground, onBackgroundMenu } = props
  const config = readOptions(options)
  // Media processing can emit fresh query arrays without changing identities.
  // Do not cancel/restart the metadata read for those notifications.
  const idsKey = useMemo(() => JSON.stringify(ids), [ids])
  const [dates, setDates] = useState<Map<string, number>>(new Map())
  const cache = useRef(new Map<string, number>())
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    const retained = new Map(ids.filter(id => cache.current.has(id)).map(id => [id, cache.current.get(id)!]))
    const missing = ids.filter(id => !retained.has(id))
    setError('')
    void (async () => {
      for (let start = 0; start < missing.length; start += 8192) {
        const batch = missing.slice(start, start + 8192)
        const identities = await host.core.getIdentities(batch)
        if (!alive) return
        for (const id of batch) retained.set(id, NaN)
        for (const { id, createdAt } of identities) retained.set(id, createdAt)
      }
      if (alive) { cache.current = retained; setDates(retained) }
    })().catch(e => { if (alive) setError(String(e instanceof Error ? e.message : e)) })
    return () => { alive = false }
  }, [idsKey, host.core, retry])
  const ready = useMemo(() => ids.every(id => dates.has(id)), [ids, dates])
  const groups = useMemo(() => ready ? groupItems(ids, dates, config.group, config.ascending, locale) : [], [ready, ids, dates, config.group, config.ascending, locale])
  const [collapsed, setCollapsed] = useState(() => readCollapsed(state))
  const order = useMemo(() => groups.filter(g => !collapsed.has(g.key)).flatMap(g => g.ids), [groups, collapsed])
  const scroller = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0, top: 0 })
  useLayoutEffect(() => {
    const el = scroller.current!
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight, top: el.scrollTop })
    const ro = new ResizeObserver(update); ro.observe(el); update()
    return () => ro.disconnect()
  }, [])
  const size = Number.isFinite(zoom) ? Math.max(120, Math.min(320, zoom)) : 180
  const layout = useMemo(() => arrange(groups, collapsed, viewport.width, size), [groups, collapsed, viewport.width, size])
  const restored = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    // 首屏出现滚动条时可用宽度会变；等行高与实际宽度一致后再还原锚点。
    if (restored.current || !ids.length || !ready || !el?.clientHeight || viewport.width !== el.clientWidth || !viewport.width) return
    restored.current = true
    const offset = typeof state?.offset === 'number' && Number.isFinite(state.offset) ? Math.max(0, state.offset) : 0
    el.scrollTop = (anchor ? layout.positions.get(anchor) ?? 0 : 0) + offset
    setViewport(v => ({ ...v, top: el.scrollTop }))
  }, [ready, viewport.width, viewport.height, layout, anchor, state])
  const first = rowAt(layout.rows, Math.max(0, viewport.top - 400))
  const last = rowAt(layout.rows, viewport.top + viewport.height + 400) + 1
  const shown = layout.rows.slice(first, last)
  const visibleIds = shown.flatMap(row => row.ids)
  const visibleKey = JSON.stringify(visibleIds)
  useEffect(() => {
    if (!visible || !ready) return
    const t = setTimeout(() => { void host.core.visible(JSON.parse(visibleKey)).catch(() => {}) }, 150)
    return () => clearTimeout(t)
  }, [host.core, visible, ready, visibleKey])
  const recordPosition = (top: number, nextCollapsed = collapsed) => {
    const row = layout.rows[rowAt(layout.rows, top)]
    if (row) {
      onAnchor(row.ids[0] ?? row.group.ids[0])
      onState({ collapsed: [...nextCollapsed].slice(-512), offset: Math.max(0, top - row.top) })
    }
  }
  return <div className="rm-timeline">
    <div className="rm-timeline-bar">
      <span>{uiText("收录时间 ·")}{' '}{groups.length}{' '}{uiText("组")}</span>
      <select aria-label={uiText("跳转到日期")} value="" disabled={!ready || !groups.length} onChange={e => {
        const row = layout.rows.find(r => r.header && r.group.key === e.target.value)
        if (row && scroller.current) scroller.current.scrollTop = row.top
      }}><option value="">{uiText("跳转到…")}</option>{groups.map(g => <option key={g.key} value={g.key}>{g.label} · {g.ids.length}</option>)}</select>
    </div>
    <div className="rm-timeline-scroll" ref={scroller} onScroll={e => {
      const top = e.currentTarget.scrollTop
      setViewport(v => ({ ...v, top })); if (restored.current) recordPosition(top)
    }} onMouseDown={e => { if (!(e.target as Element).closest('[data-entity-id], button')) onBackground() }}
      onContextMenu={e => { if (!(e.target as Element).closest('[data-entity-id], button')) onBackgroundMenu(e) }}>
      {error ? <div className="rm-timeline-message" role="alert">{uiText("读取收录时间失败：")}{error} <button onClick={() => setRetry(n => n + 1)}>{uiText("重试")}</button></div>
        : !ready ? <div className="rm-timeline-message" role="status">{uiText("正在整理时间线…")}</div>
        : !ids.length ? <div className="rm-timeline-message">{uiText("没有符合条件的素材")}</div>
        : <div className="rm-timeline-content" style={{ height: layout.height }}>
          {shown.map(row => row.header
            ? <button key={row.group.key} className="rm-timeline-heading" style={{ top: row.top, height: row.height }} aria-expanded={!collapsed.has(row.group.key)} onClick={() => {
              const next = new Set(collapsed)
              if (next.has(row.group.key)) next.delete(row.group.key)
              else { if (next.size >= 512) next.delete(next.values().next().value!); next.add(row.group.key) }
              setCollapsed(next); recordPosition(scroller.current?.scrollTop ?? 0, next)
            }}><span className="rm-timeline-chevron">{collapsed.has(row.group.key) ? '▸' : '▾'}</span><strong>{row.group.label}</strong><span>{row.group.ids.length}{' '}{uiText("项")}</span></button>
            : <div key={row.ids[0]} className="rm-timeline-row" style={{ top: row.top, height: row.height }}>
              {row.ids.map((id, i) => <ResourceCard key={id} id={id} host={host} selected={selection.has(id)}
                style={{ position: 'absolute', left: i * (layout.cardWidth + 12), top: 0, width: layout.cardWidth, height: layout.cardHeight }}
                onPointer={(id, e) => onPointer(id, e, order)} onOpen={id => onOpen(id, order)} dragIds={dragIds} />)}
            </div>)}
        </div>}
    </div>
  </div>
}
function Options({ options, setOptions }: LayoutOptionsProps) {
  useUiLocale()
  const value = readOptions(options)
  return <div className="rm-timeline-options">
    <label>{uiText("时间分组")}<select value={value.group} onChange={e => setOptions({ ...options, group: e.target.value })}>
      <option value="day">{uiText("按天")}</option><option value="month">{uiText("按月")}</option><option value="year">{uiText("按年")}</option>
    </select></label>
    <label>{uiText("排列顺序")}<select value={value.ascending ? 'asc' : 'desc'} onChange={e => setOptions({ ...options, ascending: e.target.value === 'asc' })}>
      <option value="desc">{uiText("最近收录在前")}</option><option value="asc">{uiText("最早收录在前")}</option>
    </select></label>
  </div>
}
export const plugin: UiPlugin = { id: 'timeline', layouts: [{ id: 'timeline', get title() { return uiText("时间线") }, get description() { return uiText("按收录时间分组，折叠和连续浏览") },
  defaultOptions: { group: 'month', ascending: false }, size: { get label() { return uiText("卡片大小") }, min: 120, max: 320, step: 10, default: 180 }, Component: Timeline, Options }] }
