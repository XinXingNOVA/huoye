import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { normalizePdfText } from '../../plugin-api/pdf-text'
import type { PdfPageSurface } from '../../plugin-api/ui/contracts'

interface Hit { page: number; start: number; end: number }
interface PageMatches { page: number; first: number; offsets: Uint32Array }
interface Matches { pages: PageMatches[]; total: number }
const EMPTY: Matches = { pages: [], total: 0 }

interface Box { left: number; top: number; width: number; height: number }

// 与 PDF.js 文字层保持相同的 UTF-16 偏移，一次命中可以跨越多个字形片段或换行。
function hitRange(layer: HTMLElement, hit: Hit) {
  const document = layer.ownerDocument
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const range = document.createRange()
  let pos = 0, started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === 'BR') { pos++; continue }
    if (node.nodeType !== Node.TEXT_NODE) continue
    const next = pos + (node.nodeValue?.length ?? 0)
    if (!started && hit.start < next) { range.setStart(node, hit.start - pos); started = true }
    if (started && hit.end <= next) { range.setEnd(node, hit.end - pos); return range }
    pos = next
  }
}

export function PdfFind({ doc, surfaces, jump, close }: {
  doc: PDFDocumentProxy; surfaces: PdfPageSurface[]; jump(n: number): void; close(): void
}) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Matches>(EMPTY)
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState('')
  const [boxes, setBoxes] = useState<Box[]>([])
  const input = useRef<HTMLInputElement>(null)
  const cache = useRef(new Map<number, string>())
  const group = matches.pages.findLast(p => p.first <= index)
  const selected = useMemo(() => {
    if (!group) return
    const i = 2 * (index - group.first)
    return { page: group.page, start: group.offsets[i], end: group.offsets[i + 1] }
  }, [group, index])
  const surface = selected && surfaces.find(item => item.page === selected.page)
  const jumpRef = useRef(jump)
  jumpRef.current = jump

  useEffect(() => {
    let live = true
    setIndex(0); setMatches(EMPTY)
    const words = normalizePdfText(query.trim()).split(/\s+/u)
    if (!words[0]) { setStatus(''); return }
    setStatus('正在查找…')
    const timer = setTimeout(async () => {
      const pages: PageMatches[] = []
      let total = 0, reported = 0
      const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'giu')
      try {
        for (let page = 1; page <= doc.numPages && live; page++) {
          let text = cache.current.get(page)
          if (text === undefined) {
            const content = await (await doc.getPage(page)).getTextContent()
            if (!live) return
            text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
            cache.current.set(page, text)
          }
          // 异体部首与标准汉字长度相同时折叠，保留原文定位偏移。
          const normalized = normalizePdfText(text)
          const offsets: number[] = []
          for (const m of (normalized.length === text.length ? normalized : text).matchAll(pattern)) {
            offsets.push(m.index, m.index + m[0].length)
          }
          if (offsets.length) {
            pages.push({ page, first: total, offsets: Uint32Array.from(offsets) })
            total += offsets.length / 2
          }
          // 首个结果立即可读，长文档继续扫描并分批更新计数。
          if (total > reported && (!reported || page % 32 === 0)) {
            setMatches({ pages: [...pages], total })
            reported = total
          }
        }
        if (live) { setMatches({ pages, total }); setStatus(total ? '' : '无匹配') }
      } catch { if (live) setStatus('无法读取正文') }
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [doc, query])

  const revealed = useRef<Hit>(undefined)
  useEffect(() => {
    setBoxes([])
    if (!selected) return
    if (!surface) {
      if (revealed.current !== selected) jumpRef.current(selected.page)
      return
    }
    const range = hitRange(surface.textLayer, selected)
    if (!range) return
    const page = surface.element.getBoundingClientRect()
    if (!page.width || !page.height) return
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
    setBoxes(rects.map(r => ({ left: (r.left - page.left) / page.width, top: (r.top - page.top) / page.height,
      width: r.width / page.width, height: r.height / page.height })))
    const el = surface.element.parentElement?.parentElement
    if (el && rects[0] && revealed.current !== selected) {
      const bounds = el.getBoundingClientRect(), rect = rects[0]
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) el.scrollTop += rect.top - bounds.top - el.clientHeight * .32
      if (rect.left < bounds.left || rect.right > bounds.right) el.scrollLeft += rect.left - bounds.left - 20
      revealed.current = selected
    }
  }, [selected, surface])

  function move(by: number) { if (matches.total) setIndex(i => (i + by + matches.total) % matches.total) }
  return <div className="pdf-find" role="search" aria-label="文内查找" onKeyDown={e => {
    if (e.key === 'Escape' || e.key === 'Enter' && !e.nativeEvent.isComposing && e.target === input.current) {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') close()
      else move(e.shiftKey ? -1 : 1)
    }
  }}>
    <div className="search-box">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" />
      </svg>
      <input className="search-input" autoFocus ref={input} aria-label="在此 PDF 中查找" placeholder="在此 PDF 中查找"
        spellCheck={false} value={query} onChange={e => setQuery(e.target.value)} />
      <span role="status">{matches.total ? (index + 1) + ' / ' + matches.total + (status ? ' · ' + status : '') : status}</span>
    </div>
    <div className="pdf-find-actions">
      <button aria-label="上一处匹配" title="上一处匹配（Shift Enter）" disabled={!matches.total} onClick={() => move(-1)}>↑</button>
      <button aria-label="下一处匹配" title="下一处匹配（Enter）" disabled={!matches.total} onClick={() => move(1)}>↓</button>
      <button aria-label="关闭查找" title="关闭查找（Esc）" onClick={close}>×</button>
    </div>
    {surface && createPortal(boxes.map((b,i) => <i key={i} className="pdf-find-highlight" style={{ left: b.left*100+'%', top: b.top*100+'%', width: b.width*100+'%', height: b.height*100+'%' }} />), surface.element)}
  </div>
}
