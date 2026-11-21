import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { asElement, displayWindows, onDisplayEvent } from '../display-windows'
import { useEffect, useRef, type ReactNode } from 'react'
import type { UiHost } from '../plugin'
import { windowProviders } from '../ui-registry'
import { PANEL_LIMITS } from '../workspace'

export function PanelResizeHandle({ side, width, onResize, onDragging }: {
  side: 'left' | 'right'; width: number; onResize(width: number): void; onDragging(active: boolean): void
}) {
  useUiLocale()
  const drag = useRef<{ x: number; width: number } | null>(null)
  const limit = PANEL_LIMITS[side === 'left' ? 'sidebar' : 'inspector']
  const resize = (value: number) => onResize(Math.max(limit.min, Math.min(limit.max, value)))
  const finish = () => { drag.current = null; onDragging(false) }
  return <div className={`panel-resize panel-resize-${side}`} role="separator" aria-label={uiText("调整{value1}栏宽度", { value1: String(side === 'left' ? uiText("左") : uiText("右")) })}
    aria-orientation="vertical" aria-valuenow={width} aria-valuemin={limit.min} aria-valuemax={limit.max} tabIndex={0}
    title={uiText("拖动调整宽度；双击恢复默认；方向键微调")}
    onPointerDown={e => {
      if (e.button !== 0) return
      e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, width }; onDragging(true)
    }}
    onPointerMove={e => { if (drag.current) resize(drag.current.width + (e.clientX - drag.current.x) * (side === 'left' ? 1 : -1)) }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => onResize(limit.initial)}
    onKeyDown={e => {
      if (['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation()
        resize(e.key === 'Home' ? limit.initial : width + (e.key === 'ArrowRight' ? 10 : -10) * (side === 'left' ? 1 : -1))
      }
    }}/>
}

/** Provider 类型与 key 稳定，切换标签页不会重新建立窗口会话。 */
export function WindowProviders({ host, children }: { host: UiHost; children: ReactNode }) {
  useEffect(() => {
    // 所有现有音视频和外部播放器共用；新的显式播放暂停其他媒体，不自动恢复。
    const play = (event: Event) => {
      if (!['AUDIO', 'VIDEO'].includes(asElement(event.target)?.tagName ?? '')) return
      for (const win of displayWindows()) for (const media of win.document.querySelectorAll<HTMLMediaElement>('audio,video')) {
        if (media !== event.target && !media.paused) media.pause()
      }
    }
    return onDisplayEvent('play', play, true)
  }, [])
  return windowProviders().reduceRight<ReactNode>((inside, p) => <p.Component key={p.id} host={host}>{inside}</p.Component>, children)
}
