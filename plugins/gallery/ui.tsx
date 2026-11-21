import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import './gallery.css'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import type { LayoutOptionsProps, LayoutProps, UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { useEntityState } from '@resource-manager/plugin-api/ui/data'
import { ResourceCover } from '@resource-manager/plugin-api/ui/media'
import { locate, readOptions, windowRange } from './model'

const uiText = packageMessages('gallery')


function Image({ view, host, fit }: { view: EntityView; host: UiHost; fit: 'contain' | 'cover' }) {
  useUiLocale()
  const [failed, setFailed] = useState(false)
  const file = view.blocks.file
  return failed ? <div className="rm-gallery-fallback"><ResourceCover view={view} host={host} /><span>{uiText("原图暂不可用，可打开素材查看详情")}</span></div>
    : <img className="rm-gallery-original" style={{ objectFit: fit }} src={host.url(String(file.data.path), file.seq)} alt={host.title(view)} draggable={false} onError={() => setFailed(true)} />
}
const Thumb = memo(function Thumb({ id, host }: { id: string; host: UiHost }) {
  useUiLocale()
  const item = useEntityState(id)
  return <><div className="rm-gallery-thumb-cover">{item.view ? <ResourceCover view={item.view} host={host} /> : <span>…</span>}</div>
    <span className="rm-gallery-thumb-title" title={item.view ? host.title(item.view) : ''}>{item.view ? host.title(item.view) : uiText("读取中")}</span></>
})

function Gallery(props: LayoutProps) {
  useUiLocale()
  const { ids, host, options, zoom, state, anchor, active, visible, selection, onState, onAnchor, onPointer, onOpen, dragIds, onBackgroundMenu } = props
  const config = readOptions(options), vertical = config.strip === 'right'
  const [cursor, setCursor] = useState(() => ({ id: typeof state?.current === 'string' ? state.current : anchor, index: typeof state?.index === 'number' ? state.index : 0 }))
  const current = useMemo(() => locate(ids, cursor.id, cursor.index), [ids, cursor.id, cursor.index])
  const item = useEntityState(current.id)
  const size = Number.isFinite(zoom) ? Math.max(64, Math.min(160, zoom)) : 100
  const cell = vertical ? Math.round(size * 0.7) + 34 : size + 12
  const scroller = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null)
  const pendingReveal = useRef(false), measured = useRef(false), restored = useRef(false)
  const [viewport, setViewport] = useState({ offset: 0, extent: 0 })
  const offset = useRef(typeof state?.stripOffset === 'number' && Number.isFinite(state.stripOffset) ? Math.max(0, state.stripOffset) : 0)
  const save = (id = current.id, index = current.index) => {
    if (id) onAnchor(id)
    onState({ current: id ?? null, index: Math.max(0, index), stripOffset: offset.current })
  }
  useLayoutEffect(() => {
    const el = scroller.current!
    if (measured.current) pendingReveal.current = true
    measured.current = true
    const update = () => setViewport({ offset: vertical ? el.scrollTop : el.scrollLeft, extent: vertical ? el.clientHeight : el.clientWidth })
    const ro = new ResizeObserver(update); ro.observe(el); update()
    return () => ro.disconnect()
  }, [vertical, size])
  const navigate = (index: number) => {
    const next = locate(ids, undefined, index)
    setCursor(next); pendingReveal.current = true; save(next.id, next.index)
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || current.index < 0) return
    const extent = vertical ? el.clientHeight : el.clientWidth
    if (!extent) return
    // The initial query is asynchronous. Setting scroll on an empty track clamps
    // it to zero, so restore only after the saved item/track can actually exist.
    if (!restored.current) {
      restored.current = true
      if (vertical) el.scrollTop = offset.current; else el.scrollLeft = offset.current
      setViewport({ offset: vertical ? el.scrollTop : el.scrollLeft, extent })
    }
    const start = current.index * cell, end = start + cell
    // Reconcile filtering/deletion without replacing the chosen item's identity on reorder.
    if (current.id !== cursor.id || current.index !== cursor.index) {
      setCursor(current); pendingReveal.current = true; save(current.id, current.index)
    }
    if (pendingReveal.current) {
      pendingReveal.current = false
      const old = vertical ? el.scrollTop : el.scrollLeft
      const next = start < old ? start : end > old + extent ? end - extent : old
      if (vertical) el.scrollTop = next; else el.scrollLeft = next
    }
  }, [current.id, current.index, cursor.id, cursor.index, ids, cell, vertical, viewport.extent])
  const range = windowRange(ids.length, viewport.offset, viewport.extent, cell)
  const shown = ids.slice(range.first, range.last)
  const visibleKey = JSON.stringify([...new Set([...shown, ...(current.id ? [current.id] : [])])])
  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => { void host.core.visible(JSON.parse(visibleKey)).catch(() => {}) }, 150)
    return () => clearTimeout(timer)
  }, [host.core, visible, visibleKey])
  const focus = (e: React.MouseEvent) => {
    if (e.button === 0 && !(e.target as Element).closest('button, input, select')) root.current?.focus({ preventScroll: true })
  }
  const view = item.view
  return <div className={`rm-gallery rm-gallery-${config.strip}`} ref={root} tabIndex={0} aria-label={uiText("画廊浏览")} onMouseDown={focus}
    onKeyDown={e => {
      if (!active || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return
      const move = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
      if (move || e.key === 'Home' || e.key === 'End') {
        e.preventDefault(); e.stopPropagation()
        navigate(e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : current.index + move)
      }
    }}>
    <div className="rm-gallery-bar">
      <button aria-label={uiText("上一项")} disabled={current.index <= 0} onClick={() => navigate(current.index - 1)}>‹</button>
      <div className="rm-gallery-caption"><strong title={view ? host.title(view) : ''}>{view ? host.title(view) : ids.length ? uiText("读取中…") : uiText("画廊")}</strong><span>{current.index + 1} / {ids.length}</span></div>
      <button aria-label={uiText("下一项")} disabled={current.index < 0 || current.index >= ids.length - 1} onClick={() => navigate(current.index + 1)}>›</button>
      <button disabled={!current.id} onClick={() => { if (current.id) onOpen(current.id, ids) }}>{uiText("打开")}</button>
    </div>
    <div className="rm-gallery-body">
      <div className={`rm-gallery-stage${current.id && selection.has(current.id) ? ' is-selected' : ''}`} data-entity-id={current.id}
        draggable={!!view} onDragStart={e => { if (current.id) host.startDrag(e, dragIds(current.id)) }}
        onMouseDown={e => { if (current.id) onPointer(current.id, e, ids) }}
        onDoubleClick={() => { if (current.id) onOpen(current.id, ids) }}
        onContextMenu={e => { if (!current.id) onBackgroundMenu(e) }}>
        {!ids.length ? <span className="rm-gallery-message">{uiText("没有符合条件的素材")}</span>
          : item.status === 'error' ? <span className="rm-gallery-message" role="alert">{uiText("读取失败，请切换素材后重试")}</span>
          : item.status === 'missing' ? <span className="rm-gallery-message">{uiText("素材已不存在")}</span>
          : view ? view.blocks.image && typeof view.blocks.file?.data.path === 'string'
            ? <Image key={`${view.id}:${view.blocks.file.seq}`} view={view} host={host} fit={config.fit} />
            : <div className="rm-gallery-cover"><ResourceCover view={view} host={host} /></div>
          : <span className="rm-gallery-message" role="status">{uiText("正在读取…")}</span>}
        {current.id && selection.has(current.id) ? <span className="rm-gallery-selected">{uiText("已选择")}</span> : null}
      </div>
      <div className="rm-gallery-strip" ref={scroller} style={vertical ? { width: size + 28 } : { height: Math.round(size * 0.7) + 56 }} aria-label={uiText("缩略图列表")}
        onContextMenu={e => { if (!(e.target as Element).closest('[data-entity-id]')) onBackgroundMenu(e) }}
        onScroll={e => {
          if (!restored.current) return
          offset.current = vertical ? e.currentTarget.scrollTop : e.currentTarget.scrollLeft
          setViewport(v => ({ ...v, offset: offset.current })); save()
        }}>
        <div className="rm-gallery-track" style={vertical ? { height: ids.length * cell, width: '100%' } : { width: ids.length * cell, height: '100%' }}>
          {shown.map((id, i) => <div key={id} className={`rm-gallery-thumb${id === current.id ? ' is-current' : ''}${selection.has(id) ? ' is-selected' : ''}`}
            role="button" tabIndex={id === current.id ? 0 : -1} aria-label={uiText("浏览第 {value1} 项", { value1: String(range.first + i + 1) })} aria-current={id === current.id ? 'true' : undefined}
            data-entity-id={id} style={{ width: size, height: Math.round(size * 0.7) + 26, ...(vertical ? { top: (range.first + i) * cell + 6, left: 10 } : { left: (range.first + i) * cell + 6, top: 8 }) }}
            onMouseDown={e => { onPointer(id, e, ids); if (e.button === 0) { navigate(range.first + i) } }}
            onDoubleClick={() => onOpen(id, ids)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOpen(id, ids) } }}
            draggable onDragStart={e => host.startDrag(e, dragIds(id))}>
            <Thumb id={id} host={host} />{selection.has(id) ? <span className="rm-gallery-tick" aria-label={uiText("已选择")}>✓</span> : null}
          </div>)}
        </div>
      </div>
    </div>
  </div>
}
function Options({ options, setOptions }: LayoutOptionsProps) {
  useUiLocale()
  const value = readOptions(options)
  return <div className="rm-gallery-options">
    <label>{uiText("图片显示")}<select value={value.fit} onChange={e => setOptions({ ...options, fit: e.target.value })}><option value="contain">{uiText("完整显示")}</option><option value="cover">{uiText("填满预览区")}</option></select></label>
    <label>{uiText("缩略图位置")}<select value={value.strip} onChange={e => setOptions({ ...options, strip: e.target.value })}><option value="bottom">{uiText("底部")}</option><option value="right">{uiText("右侧")}</option></select></label>
  </div>
}
export const plugin: UiPlugin = { id: 'gallery', layouts: [{ id: 'gallery', get title() { return uiText("画廊") }, get description() { return uiText("大预览与缩略图带，连续挑选素材") },
  defaultOptions: { fit: 'contain', strip: 'bottom' }, size: { get label() { return uiText("缩略图大小") }, min: 64, max: 160, step: 8, default: 104 }, Component: Gallery, Options }] }
