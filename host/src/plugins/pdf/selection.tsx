import { ContentSurface, selectionRect, type ContentLocation } from '../../plugin-api/ui/selection'
import type { PdfPageSurface, PdfOverlayProps } from '../../plugin-api/ui/contracts'
import { normalizePdfText } from '../../plugin-api/pdf-text'
import { pdfLocationData, type PdfFragment, type PdfRect } from './location'
const clamp = (n: number) => Math.max(0, Math.min(1, n))
const round = (n: number) => Math.round(n * 1000000) / 1000000

/** 只收页中文字：不会把工具栏、页间空白或其他标签页的选区写进摘录。 */
function selectionIn(pages: PdfPageSurface[]): PdfFragment[] | undefined {
  const selection = pages[0]?.element.ownerDocument.defaultView?.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  const first = pages.find((p) => p.textLayer.contains(range.startContainer))
  const last = pages.find((p) => p.textLayer.contains(range.endContainer))
  if (!first || !last) return
  const selected = pages.filter((p) => p.page >= first.page && p.page <= last.page)
  if (selected.length !== last.page - first.page + 1) return
  const parts: PdfFragment[] = []
  for (const p of selected) {
    const local = range.startContainer.ownerDocument!.createRange()
    local.selectNodeContents(p.textLayer)
    if (p === first) local.setStart(range.startContainer, range.startOffset)
    if (p === last) local.setEnd(range.endContainer, range.endOffset)
    const copy = local.cloneContents()
    copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
    const quote = normalizePdfText(copy.textContent ?? '').trim()
    if (!quote) continue
    const base = p.element.getBoundingClientRect()
    if (!base.width || !base.height) continue
    const rects: PdfRect[] = []
    const seen = new Set<string>()
    for (const r of local.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue
      const x = clamp((r.left - base.left) / base.width), y = clamp((r.top - base.top) / base.height)
      const w = clamp((r.right - base.left) / base.width) - x, h = clamp((r.bottom - base.top) / base.height) - y
      if (w <= 0 || h <= 0) continue
      const box = { x: round(x), y: round(y), w: round(w), h: round(h) }
      if (!box.w || !box.h) continue
      const key = JSON.stringify(box)
      if (!seen.has(key)) { rects.push(box); seen.add(key) }
    }
    if (rects.length) parts.push({ page: p.page, quote, rects })
  }
  return parts.length ? parts : undefined
}


export const pdfLocation: ContentLocation = {
  id: 'pdf.quote', version: 1, match: v => !!v.blocks.pdf, open: (ref, focus) => {
    const data = pdfLocationData(ref.locator); return data ? { tab: 'pdf.viewer', params: { id: ref.sourceId, page: data.fragments[0].page, focus, request: Date.now() } } : undefined
  }
}
export function PdfSelection(p: PdfOverlayProps & { tabId: string }) {
  return <ContentSurface host={p.host} tabId={p.tabId} surfaceId="pdf.pages" source={p.target} revision={String(p.target.blocks.file?.data.hash)} root={p.root.parentElement!} active={p.active} version={p.pages}
    selected={p.selected} select={p.select} revealId={p.revealId} revealKey={p.revealKey}
    read={() => {
const fragments = selectionIn(p.pages), selection = p.root.ownerDocument.defaultView?.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : undefined; const rect = range && [...range.getClientRects()].filter(r => r.width && r.height).at(-1)
      return fragments && rect ? { text: fragments.map(f => f.quote).join('\n\n'), rect: selectionRect(rect), locator: { provider: 'pdf.quote', version: 1, data: { sourceHash: p.target.blocks.file.data.hash, fragments } } } : undefined
}}
    locate={ref => {
const data = pdfLocationData(ref.locator); if (!data) return { status: 'unsupported', rects: [] }; if (data.sourceHash !== p.target.blocks.file?.data.hash) return { status: 'missing', rects: [] }
      const rects = data.fragments.flatMap(f => { const page = p.pages.find(p => p.page === f.page); if (!page) return []; const b = page.element.getBoundingClientRect(); return f.rects.map(r => ({ left: b.left + r.x * b.width, top: b.top + r.y * b.height, width: r.w * b.width, height: r.h * b.height })) })
      return { status: rects.length ? 'found' : 'elsewhere', rects }
    }}
    reveal={ref => { const data = pdfLocationData(ref.locator); if (data) p.reveal(data.fragments[0].page, data.sourceHash === p.target.blocks.file?.data.hash ? Math.max(0, data.fragments[0].rects[0].y - .12) : 0) }} />
}
