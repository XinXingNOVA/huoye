// PDF 提供页框和文字层；批注以页码 + 比例矩形记录，可跨页，缩放不改数据。
import { useEffect, useMemo, useRef } from 'react'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import type { PdfOverlayProps, PdfPageSurface } from '@resource-manager/plugin-api/ui/contracts'
import type { PdfFragment } from './blocks'
import { isPdfQuote, labelOf, useLocals } from './common'
import './pdf.css'

function boxesOf(parts: PdfFragment[], pages: PdfPageSurface[], root: HTMLElement) {
  const origin = root.getBoundingClientRect()
  return parts.flatMap((part) => {
    const page = pages.find((p) => p.page === part.page)
    if (!page) return []
    const box = page.element.getBoundingClientRect()
    return part.rects.map((r) => ({ left: box.left - origin.left + r.x * box.width, top: box.top - origin.top + r.y * box.height, width: r.w * box.width, height: r.h * box.height }))
  })
}

export function PdfQuoteLayer(props:PdfOverlayProps) {
  const ids=useLocals(props.host,props.target.id)
  return <div className="pdf-annotations">{ids.map(id=><PdfHighlight key={id} {...props} id={id} selected={props.selected===id}/>)}</div>
}

function PdfHighlight({ id, target, host, active, root, pages, selected, select, revealId, revealKey, reveal }: Omit<PdfOverlayProps, 'selected'> & { id: string; selected: boolean }) {
  const view = useEntity(id)
  const anchor = view?.blocks.anchor?.data
  const parts = useMemo(() => view && isPdfQuote(view) ? anchor?.fragments as PdfFragment[] : [], [anchor])
  const found = !!anchor && anchor.sourceHash === target.blocks.file?.data.hash && view?.blocks.place?.data.found !== false
  const boxes = active && found ? boxesOf(parts, pages, root) : []
  const lastReveal = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!active || revealId !== id || lastReveal.current === revealKey || !parts.length || !pages.length) return
    lastReveal.current = revealKey
    reveal(parts[0].page, found ? Math.max(0, parts[0].rects[0].y - 0.12) : 0)
  }, [id, active, revealId, revealKey, parts, pages.length, reveal, found])
  useEffect(() => {
    if (!boxes.length) return
    const click = (event: MouseEvent) => {
      if ((event.target as Element).closest('.pdf-annotations') || !window.getSelection()?.isCollapsed) return
      const origin = root.getBoundingClientRect()
      const x = event.clientX - origin.left, y = event.clientY - origin.top
      if (boxes.some((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height)) select(id)
    }
    root.addEventListener('click', click)
    return () => root.removeEventListener('click', click)
  }, [root, boxes, id, select])
  if (!view || !parts.length) return null
  const end = boxes[boxes.length - 1]
  return <>
    {boxes.map((box, i) => <div key={i} data-pdf-mark={id} className={`pdf-quote-mark${selected ? ' selected' : ''}`} style={box} />)}
    {selected && !found && <div className="pdf-quote-missing">原 PDF 已变化，摘录文字仍保留；请核对原文位置。</div>}
    {selected && end && <div className="pdf-quote-tools saved" style={{ left: Math.max(4, Math.min(end.left, root.clientWidth - 340)), top: end.top + end.height + 6 }}>
      <span>{labelOf(view, 35) || '已标记摘录'}</span>
      <button className="small" onClick={() => select(undefined)}>收起</button>
      <button className="small" title="删除摘录（可以撤销）" onClick={() => { host.trash([id]); select(undefined) }}>删除</button>
    </div>}
  </>
}
