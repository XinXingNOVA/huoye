import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
// 瀑布流布局（集合标签页的第一个布局）：位置只靠宽高比算出，只渲染可见范围内的卡片。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUiEffect, useUiFrame } from '../../../plugin-api/ui/hooks'
import { CAPTION, computeMasonry } from '../masonry'
import type { LayoutProps } from '../plugin'
import { linkSourceFolder } from '../link-source-folder'
import { searchesOf } from '../../../shared/query'
import { Card } from './Card'

const GAP = 14
const PAD = 18
const OVERSCAN = 600

export function Grid({ query, ids, aspects, zoom, selection, session, host, visible: pageVisible, anchor, onAnchor, onPointer, onOpen, onBackground, onBackgroundMenu, dragIds }: LayoutProps) {
  useUiLocale()
  const nextFrame = useUiFrame()
  const scroller = useRef<HTMLDivElement>(null)
  const widthProbe = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const [resize, setResize] = useState<{ ids: Set<string>; duration: number } | null>(null)

  useUiEffect(display => {
    const el = scroller.current!
    const probe = widthProbe.current!
    let lastWidth = 0
    let lastHeight = 0
    display.observeResize([el, probe], () => {
      // 外壳提供终点宽度：不要跟着侧栏动画的每一帧重新分列。
      const nextWidth = probe.getBoundingClientRect().width - (el.offsetWidth - el.clientWidth) - PAD * 2
      if (nextWidth <= 0) return
      if (nextWidth !== lastWidth) {
        const time = display.window.getComputedStyle(probe).getPropertyValue('--panel-duration').trim()
        const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000) || 0
        if (lastWidth > 0 && duration > 0) {
          // 旧位置仍在屏幕上的卡片要留到过渡结束，避免图片卸载后重新解码。
          setResize({ ids: new Set([...el.querySelectorAll<HTMLElement>('.card')].map((c) => c.dataset.entityId!)), duration })
        } else setResize(null)
        lastWidth = nextWidth
        setWidth(nextWidth)
      }
      if (el.clientHeight !== lastHeight) {
        lastHeight = el.clientHeight
        setViewport({ top: el.scrollTop, height: lastHeight })
      }
    })
  }, [])

  useUiEffect(display => {
    if (!resize) return
    // 从提交后的下一帧计时；快速反向时取消旧清理，CSS 从当前绘制位置接续。
    let timer: ReturnType<typeof setTimeout>
    display.frame(() => {
      timer = setTimeout(() => setResize(null), resize.duration + 32)
    })
    return () => clearTimeout(timer)
  }, [resize])

  const layout = useMemo(() => computeMasonry(aspects, Math.max(width, 100), zoom, GAP, CAPTION), [aspects, width, zoom])

  // 恢复滚动位置：按身份找到锚点卡片，而不是用像素值——窗口宽度一变，像素值就不对了
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || width === 0 || ids.length === 0) return
    restored.current = true
    const i = anchor ? ids.indexOf(anchor) : -1
    if (i > 0 && scroller.current) {
      scroller.current.scrollTop = layout.y[i]
      setViewport({ top: scroller.current.scrollTop, height: scroller.current.clientHeight })
    }
  }, [anchor, ids, layout, width])

  const visible = useMemo(() => {
    const top = viewport.top - OVERSCAN
    const bottom = viewport.top + viewport.height + OVERSCAN
    const out: number[] = []
    for (let i = 0; i < ids.length; i++) {
      const y = layout.y[i]
      if (y < bottom && y + layout.h[i] > top) out.push(i)
    }
    return out
  }, [ids, layout, viewport])

  const rendered = useMemo(() => {
    if (!resize) return visible
    const indices = new Set(visible)
    ids.forEach((id, i) => { if (resize.ids.has(id)) indices.add(i) })
    return [...indices].sort((a, b) => a - b)
  }, [ids, visible, resize])

  const highlighted = useMemo(() => new Set(session?.highlightedIds), [session?.highlightedIds])
  const revealed = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const target = session?.reveal, el = scroller.current
    if (!pageVisible || !target || !el || width <= 0 || revealed.current === target.token) return
    const index = ids.indexOf(target.id)
    if (index < 0) return
    restored.current = true
    el.scrollTop = layout.y[index]
    revealed.current = target.token
    setViewport({ top: el.scrollTop, height: el.clientHeight })
  }, [session?.reveal, pageVisible, ids, layout, width])
  useLayoutEffect(() => {
    const el = scroller.current
    if (!session || !pageVisible || width <= 0 || !el) return
    const mounted = rendered.map(i => ids[i])
    const target = session.reveal
    // scrollTop 已更新但 React 仍可能在提交上一视口；等定位卡片实际进入可见区域再回执。
    const card = target && [...el.querySelectorAll<HTMLElement>('[data-entity-id]')].find(c => c.dataset.entityId === target.id)
    const bounds = el.getBoundingClientRect(), rect = card?.getBoundingClientRect()
    const inViewport = rect && rect.bottom > bounds.top && rect.top < bounds.bottom
    session.onRendered({ revision: session.revision, ids: mounted, ...(target && inViewport && revealed.current === target.token ? { revealToken: target.token } : {}) })
  }, [session, pageVisible, width, rendered, ids, viewport])

  // 当前标签页才告诉核心进程哪些在屏幕上，加工时优先处理
  const visibleIds = useMemo(() => visible.map((i) => ids[i]), [visible, ids])
  useEffect(() => {
    if (!pageVisible) return
    const t = setTimeout(() => host.core.visible(visibleIds), 200)
    return () => clearTimeout(t)
  }, [visibleIds, host, pageVisible])

  // 报告滚动锚点：最上方那张卡片
  useEffect(() => {
    if (!restored.current) return
    let best = -1
    for (const i of visible) {
      if (layout.y[i] + layout.h[i] <= viewport.top + PAD) continue
      if (best < 0 || layout.y[i] < layout.y[best] || (layout.y[i] === layout.y[best] && layout.x[i] < layout.x[best])) best = i
    }
    if (best >= 0) onAnchor(ids[best])
  }, [visible, viewport.top, layout, ids, onAnchor])

  const cancelFrame = useRef<(() => void) | undefined>(undefined)
  const onScroll = () => {
    cancelFrame.current?.()
    cancelFrame.current = nextFrame(() => {
      const el = scroller.current
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight })
    })
  }

  return (
    <div
      className={`grid-scroller${resize ? ' resizing' : ''}`}
      ref={scroller}
      onScroll={onScroll}
      onContextMenu={(e) => onBackgroundMenu(e)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('grid-canvas')) onBackground()
      }}
    >
      <div className="grid-width-probe" ref={widthProbe} aria-hidden="true" />
      <div className="grid-canvas" style={{ height: layout.height + PAD * 2 }}>
        {rendered.map((i) => (
          <Card
            key={ids[i]}
            id={ids[i]}
            host={host}
            selected={selection.has(ids[i])}
            highlighted={highlighted.has(ids[i])}
            onPointer={onPointer}
            onOpen={onOpen}
            dragIds={dragIds}
            style={{
              transform: `translate(${layout.x[i] + PAD}px, ${layout.y[i] + PAD}px)`,
              width: layout.colWidth,
              height: layout.h[i],
              ['--cover-h' as string]: `${layout.h[i] - CAPTION}px`
            }}
          />
        ))}
      </div>
      {ids.length === 0 && (
        <div className="empty">
          <div className="empty-card">
            <div className="empty-icon" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="M3 10h18" />
                <path d="M9 15h6" />
              </svg>
            </div>
            <p>{query?.scope === 'trash' ? uiText("回收站为空") : uiText("当前没有素材")}</p>
            <span className="empty-hint muted">
              {query?.scope === 'trash'
                ? uiText("移到回收站的素材会显示在这里，可随时恢复或彻底删除")
                : uiText("将文件或文件夹直接拖入此窗口收录，或在空白处右键新建内容")}
            </span>
            {query?.scope === 'content' && (!query.role || query.role === 'browse') && !query.has?.length && !query.lacks?.length && !query.where?.length && !query.ids && !searchesOf(query).length &&
              <button className="small" onClick={() => void linkSourceFolder(host)}>{uiText("关联本地文件夹（不复制）…")}</button>}
          </div>
        </div>
      )}
    </div>
  )
}
