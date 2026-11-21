import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// 图片查看器标签页：图片插件提供的单素材标签页（设计文档 10.4）。
// 双击图片打开；在打开它的列表里切上一张 / 下一张；滚动平移，捏合或 ⌘ 加滚动缩放。
// 开放图片的比例坐标作为叠加层（8.3）：批注插件在上面圈选、显示局部。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { Query } from '../../shared/query'
import { useEntity } from '../../plugin-api/ui/data'
import { useKeys, useUiEffect } from '../../plugin-api/ui/hooks'
import { useNeighbors, type Neighbors } from '../../plugin-api/ui/navigation'
import type { KeyHandler, TabProps, TabType, UiHost } from '../../plugin-api/ui/contracts'

export interface ViewerParams extends Record<string, unknown> {
  id: string
  /** 打开它的列表：上一张 / 下一张在这里面找。 */
  list?: Query
  /** 打开时定位到的身份（例如从局部的卡片打开：放大到那一块并选中）。 */
  focus?: string
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const MIN_SCALE = 0.05
const MAX_SCALE = 16

interface ImageState { id: string; hash: string; zoom: number | 'fit'; pan: { x: number; y: number } }

function Viewer({ params, host, expose, setFocus, setParams, registerKeys, saved, setState }: TabProps<ViewerParams, ImageState>) {
  useUiLocale()
  const view = useEntity(params.id)
  const contextTitle = view ? host.title(view) : uiText("图片查看页")
  useEffect(() => expose({ context: { title: contextTitle } }), [expose, contextTitle])
  const nav = useNeighbors(host, params.list, params.id, 'image')
  const [selected, setSelected] = useState(params.focus)

  useEffect(() => setSelected(params.focus), [params.focus, params.id])
  // 焦点：选中的局部，或者这张图本身。检查器跟着显示
  useEffect(() => setFocus([selected ?? params.id]), [selected, params.id, setFocus])

  const go = (id: string | undefined) => {
    if (id) setParams({ ...params, id, focus: undefined })
  }

  if (!view) return <Status>{uiText("正在读取…")}</Status>
  if (view.deletedAt) {
    return (
      <Status>{uiText("已移到回收站")}{' '}<button className="small" onClick={() => host.core.restore([view.id])}>{uiText("恢复")}{' '}</button>
      </Status>
    )
  }
  if (!view.blocks.image || !view.blocks.file) return <Status>{uiText("不是图片")}</Status>
  return (
    <Canvas
      key={`${view.id}:${view.blocks.file.data.hash}`}
      view={view}
      saved={saved?.id === view.id && saved.hash === view.blocks.file.data.hash ? saved : undefined}
      report={setState}
      host={host}
      selected={selected}
      select={setSelected}
      revealId={params.focus}
      registerKeys={registerKeys}
      nav={nav}
      go={go}
    />
  )
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="viewer">
      <div className="viewer-stage">
        <div className="player-status">{children}</div>
      </div>
    </div>
  )
}

interface CanvasProps {
  view: EntityView
  saved?: ImageState
  report(state: ImageState): void
  host: UiHost
  selected?: string
  select(id: string | undefined): void
  revealId?: string
  registerKeys(h: KeyHandler | null): void
  nav: Neighbors
  go(id: string | undefined): void
}

function Canvas({ view, host, selected, select, revealId, registerKeys, nav, go, saved, report }: CanvasProps) {
  useUiLocale()
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const imgW = Number(view.blocks.image.data.width) || 1
  const imgH = Number(view.blocks.image.data.height) || 1
  /** 'fit'：整张放进窗口（小图不放大）。 */
  const [zoom, setZoom] = useState<number | 'fit'>(() => typeof saved?.zoom === 'number' && Number.isFinite(saved.zoom) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.zoom)) : 'fit')
  /** 图片中心相对窗口中心的偏移（屏幕像素）。 */
  const [pan, setPan] = useState(() => saved?.pan && Number.isFinite(saved.pan.x) && Number.isFinite(saved.pan.y) ? saved.pan : { x: 0, y: 0 })

  useEffect(() => { report({ id: view.id, hash: String(view.blocks.file.data.hash), zoom, pan }) }, [view.id, view.blocks.file.data.hash, zoom, pan, report])

  useUiEffect(display => {
    const el = stage.current!
    display.observeResize(el, () => setSize({ w: el.clientWidth, h: el.clientHeight }))
  }, [])

  const fit = size.w ? Math.min((size.w - 40) / imgW, (size.h - 40) / imgH, 1) : 1
  const scale = zoom === 'fit' ? fit : zoom
  const w = imgW * scale
  const h = imgH * scale
  const left = (size.w - w) / 2 + pan.x
  const top = (size.h - h) / 2 + pan.y

  /** 以窗口里的一点为中心缩放：那一点下面的图片内容不动。 */
  const zoomAt = (next: number, cx = size.w / 2, cy = size.h / 2) => {
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next))
    const px = (cx - left) / scale
    const py = (cy - top) / scale
    setZoom(s)
    setPan({ x: cx - px * s - (size.w - imgW * s) / 2, y: cy - py * s - (size.h - imgH * s) / 2 })
  }

  const fitAll = () => {
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }

  /** 放大到一块区域（比例坐标），放在窗口中间。 */
  const reveal = useCallback(
    (r: Rect) => {
      if (!size.w) return
      const s = Math.max(fit, Math.min(MAX_SCALE, (size.w * 0.6) / (r.w * imgW), (size.h * 0.6) / (r.h * imgH)))
      const cx = (r.x + r.w / 2) * imgW
      const cy = (r.y + r.h / 2) * imgH
      setZoom(s)
      setPan({ x: (imgW * s) / 2 - cx * s, y: (imgH * s) / 2 - cy * s })
    },
    [size.w, size.h, fit, imgW, imgH]
  )

  useKeys(registerKeys, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
      case 'ArrowLeft':
      case 'p':
        go(nav.prev)
        return true
      case 'ArrowRight':
      case 'n':
        go(nav.next)
        return true
      case '0':
        fitAll()
        return true
      case '1':
        zoomAt(1)
        return true
      case '=':
      case '+':
        zoomAt(scale * 1.25)
        return true
      case '-':
        zoomAt(scale / 1.25)
        return true
      case 'Escape':
        if (!selected) return false
        select(undefined)
        return true
    }
    return false
  })

  const file = view.blocks.file
  const overlays = host.overlays('region')

  return (
    <div className="viewer" data-image-id={view.id}>
      <div className="player-bar viewer-bar image-viewer-bar">
        <div className="player-controls">
          <button className="player-btn" aria-label={uiText("上一张")} title={uiText("上一张（← / P）")} disabled={!nav.prev} onClick={() => go(nav.prev)}>
            ‹
          </button>
          <button className="player-btn" aria-label={uiText("下一张")} title={uiText("下一张（→ / N）")} disabled={!nav.next} onClick={() => go(nav.next)}>
            ›
          </button>
          <span className="player-title">
            {host.title(view)}
          </span>
          <span className="image-viewer-position" aria-live="polite">{nav.index >= 0 ? `${nav.index + 1} / ${nav.total}` : uiText("单张查看")}</span>
          {overlays.length > 0 && <span className="muted viewer-hint">{uiText("在图上拖出一块区域可以批注")}</span>}
          <button className="small" aria-label={uiText("缩小图片")} title={uiText("缩小（−）")} disabled={scale <= MIN_SCALE} onClick={() => zoomAt(scale / 1.25)}>−</button>
          <span className="player-time">{Math.round(scale * 100)}%</span>
          <button className="small" aria-label={uiText("放大图片")} title={uiText("放大（+）")} disabled={scale >= MAX_SCALE} onClick={() => zoomAt(scale * 1.25)}>＋</button>
          <button className="small" title={uiText("整张放进窗口（0）")} onClick={fitAll}>{uiText("适应")}{' '}</button>
          <button className="small" title={uiText("原始大小（1）")} onClick={() => zoomAt(1)}>
            100%
          </button>
        </div>
      </div>
      <div
        className="viewer-stage"
        ref={stage}
        onWheel={(e) => {
          // 触控板捏合是带 ctrlKey 的滚动
          if (e.ctrlKey || e.metaKey) zoomAt(scale * Math.exp(-e.deltaY * 0.01), e.clientX - e.currentTarget.getBoundingClientRect().left, e.clientY - e.currentTarget.getBoundingClientRect().top)
          else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
        }}
        onPointerDown={(e) => {
          const display = e.currentTarget.ownerDocument.defaultView!
          // 中键拖动平移；点在图片外面取消选中
          if (e.button === 1) {
            e.preventDefault()
            const start = { x: e.clientX, y: e.clientY, pan }
            const move = (m: PointerEvent) => setPan({ x: start.pan.x + m.clientX - start.x, y: start.pan.y + m.clientY - start.y })
            const up = () => {
              display.removeEventListener('pointermove', move)
              display.removeEventListener('pointerup', up)
            }
            display.addEventListener('pointermove', move)
            display.addEventListener('pointerup', up)
          } else if (e.target === e.currentTarget) select(undefined)
        }}
      >
        <div className="viewer-image" style={{ left, top, width: w, height: h }}>
          <img src={host.url(String(file.data.path), file.seq)} draggable={false} alt="" />
          {overlays.map((o) => (
            <o.Component key={o.id} target={view} host={host} selected={selected} select={select} scale={scale} reveal={reveal} revealId={revealId} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ViewerTitle({ params, host }: { params: ViewerParams; host: UiHost }) {
  useUiLocale()
  const view = useEntity(params.id)
  return <>{view ? host.title(view) : uiText("图片")}</>
}

export const viewerTabType: TabType<ViewerParams, ImageState> = {
  id: 'image.viewer',
  instances: { scope: 'content' },
  Title: ViewerTitle,
  Component: Viewer,
  // 普通打开复用；显式新视图独立保存缩放和平移，从局部打开仍按请求定位
  key: (params) => params.id
}
