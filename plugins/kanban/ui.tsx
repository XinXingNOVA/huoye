import './style.css'
// 看板布局：集合标签页的第二个布局，用来检验"布局是扩展点"。
// 按一个单值字段分列，每一列是"视图的查询 + 字段等于某值"，各自查询、各自滚动。
// 每一列标成拖入区域：拖动卡片换列就是放入那一列的视图（设计文档 10.7），看板自己不写数据。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Query, QueryResult } from '@resource-manager/plugin-api/query'
import { ResourceCard as Card, RESOURCE_CARD_CAPTION_HEIGHT as CAPTION } from '@resource-manager/plugin-api/ui/media'
import { computeMasonry } from '@resource-manager/plugin-api/ui/layout'
import { useKinds } from '@resource-manager/plugin-api/ui/data'
import type { LayoutOptionsProps, LayoutProps, UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { columnsFor, groupableFields, resolveGroupField, type Column } from './columns'

const GAP = 10
const PAD = 10
const OVERSCAN = 600

/** 看板里卡片不要太高：竖图裁成接近方形，封面本来就是裁切填满。 */
const kanbanAspect = (a: number) => (a > 0 ? Math.min(2.4, Math.max(0.8, a)) : 1.6)

function KanbanLayout({ query, options, zoom, selection, host, visible: pageVisible, state, onState, onPointer, onOpen, onBackground, onBackgroundMenu, dragIds }: LayoutProps) {
  // 包括用户模板里的单选、复选框：模板变了跟着变
  const kinds = useKinds()
  const group = resolveGroupField(useMemo(() => groupableFields(kinds), [kinds]), options.groupBy)
  const columns = useMemo(() => (group ? columnsFor(group, kinds) : []), [group?.key, kinds])

  const scroller = useRef<HTMLDivElement>(null)
  const positions = useRef({ left: typeof state?.left === 'number' ? Math.max(0, state.left) : 0,
    anchors: Object.fromEntries(Object.entries(state?.anchors && typeof state.anchors === 'object' ? state.anchors : {}).filter((e): e is [string, string] => typeof e[1] === 'string')) })
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollLeft = positions.current.left }, [columns])
  const reportAnchor = useCallback((key: string, id: string) => {
    if (positions.current.anchors[key] === id) return
    positions.current = { ...positions.current, anchors: { ...positions.current.anchors, [key]: id } }
    onState(positions.current)
  }, [onState])

  // 各列在屏幕上的卡片合起来，告诉核心进程优先加工（只在当前标签页）
  const visible = useRef(new Map<string, string[]>())
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const activeRef = useRef(pageVisible)
  activeRef.current = pageVisible
  const send = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (activeRef.current) host.core.visible([...visible.current.values()].flat())
    }, 200)
  }, [host])
  const report = useCallback(
    (key: string, ids: string[]) => {
      visible.current.set(key, ids)
      send()
    },
    [send]
  )
  useLayoutEffect(() => {
    visible.current.clear()
  }, [columns])
  useEffect(() => {
    if (pageVisible) send()
  }, [pageVisible, send])

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!group) {
    return (
      <div className="empty" onContextMenu={(e) => onBackgroundMenu(e)}>
        <p>没有可以分列的字段</p>
        <p className="muted">看板按单选或是 / 否字段分列，例如状态</p>
      </div>
    )
  }

  return (
    <div
      className="kanban"
      ref={scroller}
      onScroll={e => {
        if (e.target !== e.currentTarget) return
        positions.current = { ...positions.current, left: e.currentTarget.scrollLeft }
        onState(positions.current)
      }}
      onContextMenu={(e) => onBackgroundMenu(e)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackground()
      }}
    >
      {columns.map((col) => (
        <KanbanColumn
          key={`${group.key}/${col.key}`}
          positionKey={`${group.key}/${col.key}`}
          anchor={positions.current.anchors[`${group.key}/${col.key}`]}
          reportAnchor={reportAnchor}
          col={col}
          query={query}
          width={zoom}
          selection={selection}
          host={host}
          onPointer={onPointer}
          onOpen={onOpen}
          onBackground={onBackground}
          onBackgroundMenu={onBackgroundMenu}
          dragIds={dragIds}
          report={report}
        />
      ))}
    </div>
  )
}

interface ColumnProps extends Pick<LayoutProps, 'query' | 'selection' | 'host' | 'onPointer' | 'onOpen' | 'onBackground' | 'onBackgroundMenu' | 'dragIds'> {
  col: Column
  positionKey: string
  anchor?: string
  reportAnchor(key: string, id: string): void
  width: number
  report(key: string, ids: string[]): void
}

const KanbanColumn = memo(function KanbanColumn({ col, positionKey, anchor, reportAnchor, query, width, selection, host, onPointer, onOpen, onBackground, onBackgroundMenu, dragIds, report }: ColumnProps) {
  const q = useMemo<Query>(() => ({ ...query, where: [...(query.where ?? []), col.cond] }), [query, col.cond])
  const result = useQuery(host, q)

  const scroller = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  useLayoutEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewport({ top: el.scrollTop, height: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => computeMasonry(result.aspects.map(kanbanAspect), width, width, GAP, CAPTION), [result.aspects, width])

  const restored = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    if (restored.current || !result.ids.length || !el?.clientHeight) return
    restored.current = true
    const index = anchor ? result.ids.indexOf(anchor) : -1
    if (index >= 0) el.scrollTop = layout.y[index]
    setViewport({ top: el.scrollTop, height: el.clientHeight })
  }, [result.ids, layout, anchor, viewport.height])

  const shown = useMemo(() => {
    const top = viewport.top - OVERSCAN
    const bottom = viewport.top + viewport.height + OVERSCAN
    const out: number[] = []
    for (let i = 0; i < result.ids.length; i++) {
      if (layout.y[i] < bottom && layout.y[i] + layout.h[i] > top) out.push(i)
    }
    return out
  }, [result.ids, layout, viewport])

  useEffect(() => report(col.key, shown.map((i) => result.ids[i])), [shown, result.ids, col.key, report])

  // 按住 Shift 连选只在这一列里
  const pointer = useCallback((id: string, e: React.MouseEvent) => onPointer(id, e, result.ids), [onPointer, result.ids])

  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const onScroll = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current
      if (el) {
        setViewport({ top: el.scrollTop, height: el.clientHeight })
        const index = result.ids.findIndex((_, i) => layout.y[i] + layout.h[i] > el.scrollTop)
        if (index >= 0) reportAnchor(positionKey, result.ids[index])
      }
    })
  }

  return (
    <section className="kanban-col" data-drop-zone={JSON.stringify(col.cond)} data-drop-title={col.title} style={{ width: width + PAD * 2 }} onContextMenu={(e) => onBackgroundMenu(e, q)}>
      <header className="kanban-head">
        <span className="kanban-title">{col.title}</span>
        <span className="muted">{result.ids.length}</span>
      </header>
      <div
        className="kanban-scroller"
        ref={scroller}
        onScroll={onScroll}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('grid-canvas')) onBackground()
        }}
      >
        <div className="grid-canvas" style={{ height: layout.height + PAD }}>
          {shown.map((i) => (
            <Card
              key={result.ids[i]}
              id={result.ids[i]}
              host={host}
              selected={selection.has(result.ids[i])}
              onPointer={pointer}
              onOpen={id => onOpen(id, result.ids)}
              dragIds={dragIds}
              style={{
                transform: `translate(${layout.x[i] + PAD}px, ${layout.y[i]}px)`,
                width: layout.colWidth,
                height: layout.h[i],
                ['--cover-h' as string]: `${layout.h[i] - CAPTION}px`
              }}
            />
          ))}
        </div>
        {result.ids.length === 0 && <div className="kanban-empty muted">拖到这里</div>}
      </div>
    </section>
  )
})

/** 一列的查询：素材变化时重新查。 */
function useQuery(host: UiHost, q: Query): QueryResult {
  const [result, setResult] = useState<QueryResult>({ ids: [], aspects: [] })
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () =>
      host.core
        .query(q)
        .then((r) => alive && setResult(r))
        .catch((e) => console.error(e))
    run()
    const off = host.core.on('listChanged', () => {
      clearTimeout(timer)
      timer = setTimeout(run, 150)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [host, q])
  return result
}

function KanbanOptions({ options, setOptions }: LayoutOptionsProps) {
  const kinds = useKinds()
  const fields = useMemo(() => groupableFields(kinds), [kinds])
  const group = resolveGroupField(fields, options.groupBy)
  if (!group) return null
  return (
    <label className="layout-option">
      按
      <select className="select" value={group.key} onChange={(e) => setOptions({ ...options, groupBy: e.target.value })}>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.title}
            {f.readonly ? '（只读）' : ''}
          </option>
        ))}
      </select>
      分列
    </label>
  )
}

export const kanbanUi: UiPlugin = {
  id: 'kanban',
  layouts: [{ id: 'kanban', title: '看板', description: '按单选或是／否字段分列，拖动素材到对应列。', size: { label: '列宽', min: 160, max: 480, step: 10, default: 220 }, Component: KanbanLayout, Options: KanbanOptions }]
}

export { kanbanUi as plugin }
