// 文字上的批注（设计文档 11.10）：在文字标签页的阅读视图里选中一段 →"批注"→ 写一句话（直接回车只划线）——
// 这一段成为一个身份（锚点：原文片段 + 前后文）。已有的划线按原文片段重新找到位置画出来；
// 原文改得找不到了，页首提示，检查器里标"原文已改"。
// 文字标签页不知道"批注"是什么：它只开放坐标（排好版的文字里的字符位置）和换算。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import type { TextIndex, TextOverlayProps, UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { isTextRange, labelOf, locateQuote, quoteOf, useLocals } from './common'

/** 相对整页的一个矩形。 */
interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** 一段文字在页面上的矩形（每行一个），相对 page。 */
function boxesOf(index: TextIndex, page: HTMLElement, from: number, to: number): Box[] {
  const range = index.range(from, to)
  if (!range) return []
  const base = page.getBoundingClientRect()
  return [...range.getClientRects()]
    .filter((r) => r.width > 0.5 && r.height > 0)
    .map((r) => ({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height }))
}

export function TextRangeLayer({ target, host, root, page, index, version, selected, select, revealId }: TextOverlayProps) {
  const locals = useLocals(host, target.id), boxes = useRef(new Map<string, Box[]>())
  const [missing, setMissing] = useState<string[]>([])
  const report = useMemo(() => {
    const found = new Map<string, boolean>()
    return (id: string, ok: boolean | undefined) => {
      if (ok === undefined) found.delete(id)
      else found.set(id, ok)
      const lost = [...found].filter(([, v]) => !v).map(([k]) => k)
      setMissing(m => m.length === lost.length && m.every((x, i) => x === lost[i]) ? m : lost)
    }
  }, [])
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed || (e.target as Element).closest('a,[data-content-selection-ui]')) return
      const base = page.getBoundingClientRect(), x = e.clientX - base.left, y = e.clientY - base.top
      for (const [id, list] of boxes.current) {
        if (list.some(b => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height)) return select(id)
      }
    }
    root.addEventListener('click', click)
    return () => root.removeEventListener('click', click)
  }, [root, page, select])
  return <div className="text-layer">
    {missing.length > 0 && <button className="text-missing" title="选中它，检查器里有原来的那一句" onClick={() => select(missing[0])}>
      {missing.length} 条批注在原文里找不到了（原文改过）
    </button>}
    {locals.map(id => <Highlight key={id} id={id} host={host} index={index} page={page} version={version}
      selected={id === selected} reveal={id === revealId} boxes={boxes.current} report={report} remove={() => host.core.trash([id])}/>)}
  </div>
}

/** 一条划线：按原文片段在现在的文字里找到位置画出来。选中时旁边显示它的笔记，可以删掉。 */
function Highlight(p: {
  id: string
  host: UiHost
  index: TextIndex
  page: HTMLElement
  version: number
  selected: boolean
  reveal: boolean
  boxes: Map<string, Box[]>
  report(id: string, found: boolean | undefined): void
  remove(): void
}) {
  const view = useEntity(p.id)
  const q = view && isTextRange(view) ? quoteOf(view) : undefined
  const at = useMemo(() => (q ? locateQuote(p.index.text, q) : undefined), [p.index, q?.quote, q?.prefix, q?.suffix, q?.offset])
  const list = useMemo(() => (at ? boxesOf(p.index, p.page, at.from, at.to) : []), [at, p.index, p.page, p.version])
  const first = useRef<HTMLDivElement>(null)

  // 告诉叠加层：点在哪里算点中它、它找不找得到（依赖都是稳定的值，免得和上层的状态来回触发）
  const { id, boxes, report } = p
  const found = q ? !!at : undefined
  useEffect(() => {
    boxes.set(id, list)
    return () => {
      boxes.delete(id)
    }
  }, [id, list, boxes])
  useEffect(() => {
    report(id, found)
    return () => report(id, undefined)
  }, [id, found, report])

  // 从摘句的卡片打开：滚到这一句，只做一次
  const revealed = useRef(false)
  useEffect(() => {
    if (p.reveal && list.length && !revealed.current) {
      revealed.current = true
      first.current?.scrollIntoView({ block: 'center' })
    }
  }, [p.reveal, list.length])

  if (!list.length) return null
  const end = list[list.length - 1]
  const label = view ? labelOf(view, 40) : ''
  return (
    <>
      {list.map((b, i) => (
        <div key={i} ref={i === 0 ? first : undefined} className={`text-mark${label ? ' noted' : ''}${p.selected ? ' selected' : ''}`} style={b} />
      ))}
      {p.selected && (
        <div className="text-mark-chip" style={{ left: Math.max(0, Math.min(end.left, p.page.clientWidth - 300)), top: end.top + end.height + 6 }}>
          <span className="segment-label">{label || <span className="muted">（只划了线）</span>}</span>
          <button className="segment-x" title="删除这条批注（可以撤销）" onClick={p.remove}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
