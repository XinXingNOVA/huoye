import { ContentSurface, selectedText, selectionRect, type ContentLocation, type ContentReference, type SelectionSurfaceProps } from '@resource-manager/plugin-api/ui/selection'
import { findTextQuote } from '@resource-manager/plugin-api/content-selection'
import type { TextIndex } from '@resource-manager/plugin-api/ui/contracts'
import type { Book, ChapterDocument } from './model'
export const epubLocation: ContentLocation = { id: 'epub.quote', version: 1, match: v => !!v.blocks.epub, open: (ref, focus) => ({ tab: 'epub.reader', params: { id: ref.sourceId, focus, location: ref.locator, request: Date.now() } }) }
/** 使用阅读树自己的文字偏移，包含换段分隔；搜索 mark 不改变位置。 */
function chapterIndex(root: HTMLElement, text: string): TextIndex {
  const nodes: { node: Text; start: number }[] = []
  for (const span of root.querySelectorAll<HTMLElement>('[data-epub-offset]')) {
    let start = Number(span.dataset.epubOffset); const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode();n;n = walker.nextNode()) { nodes.push({ node: n as Text, start }); start += n.textContent?.length ?? 0 }
  }
  return {
text, range(from, to) {
      const a = nodes.find(n => n.start <= from && n.start + n.node.length > from), b = [...nodes].reverse().find(n => n.start < to && n.start + n.node.length >= to)
      if (!a || !b) return; const range = document.createRange(); range.setStart(a.node, from - a.start); range.setEnd(b.node, to - b.start); return range
    }, offsetOf(node, offset) {
      const n = nodes.find(n => n.node === node); if (n) return n.start + offset
      if (!root.contains(node)) return
      const point = document.createRange(); point.setStart(node, offset)
      for (const n of nodes) if (point.comparePoint(n.node, 0) >= 0) return n.start
      return text.length
    }
}
}
export function EpubSelection(p: Omit<SelectionSurfaceProps, 'read' | 'locate' | 'reveal' | 'surfaceId' | 'revision'> & { content: HTMLElement; document: ChapterDocument; book: Book; go(chapter: number, offset?: number): void; onReveal(): void }) {
  const index = () => chapterIndex(p.content, p.document.text)
  const at = (ref: ContentReference) => findTextQuote(p.document.text, { quote: ref.text, prefix: String(ref.locator.data.prefix ?? ''), suffix: String(ref.locator.data.suffix ?? ''), offset: Number(ref.locator.data.from) || 0 })
  return <ContentSurface {...p} surfaceId="epub.chapter" revision={`${p.book.sourceHash}:${p.document.href}`}
    read={() => { const s = selectedText(p.content, index()); return s && { text: s.text, rect: s.rect, locator: { provider: 'epub.quote', version: 1, data: { sourceHash: p.book.sourceHash, chapter: p.document.href, from: s.from, to: s.to, prefix: s.prefix, suffix: s.suffix } } } }}
    locate={ref => {
      const l = ref.locator; if (l.provider !== 'epub.quote' || l.version !== 1) return { status: 'unsupported', rects: [] }
      if (l.data.sourceHash !== p.book.sourceHash) return { status: 'missing', rects: [] }
      if (l.data.chapter !== p.document.href) return { status: p.book.chapters.some(c => c.href === l.data.chapter) ? 'elsewhere' : 'missing', rects: [] }
      const pos = at(ref), range = pos && index().range(pos.from, pos.to)
      return { status: range ? 'found' : 'missing', rects: range ? [...range.getClientRects()].map(selectionRect) : [] }
    }}
    reveal={ref => {
      p.onReveal()
      if (ref.locator.data.sourceHash !== p.book.sourceHash) return
      const chapter = p.book.chapters.findIndex(c => c.href === ref.locator.data.chapter)
      if (chapter < 0) return
      if (p.document.href !== ref.locator.data.chapter) { p.go(chapter, Number(ref.locator.data.from) || 0); return }
      const pos = at(ref), range = pos && index().range(pos.from, pos.to)
      if (range) { const r = range.getBoundingClientRect(), v = p.root.getBoundingClientRect(); p.root.scrollTop += r.top - v.top - 60 }
    }} />
}
