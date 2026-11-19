import { ContentSurface, selectedText, selectionRect, type ContentLocation } from '../../plugin-api/ui/selection'
import { findTextQuote } from '../../plugin-api/content-selection'
import type { TextOverlayProps } from '../../plugin-api/ui/contracts'
export const textLocation: ContentLocation = { id: 'text.quote', version: 1, match: v => !!v.blocks.text || !!v.blocks.body, open: (ref, focus) => ({ tab: 'text.reader', params: { id: ref.sourceId, focus, request: Date.now() } }) }
export function TextSelection(p: TextOverlayProps & { tabId: string; active: boolean; revealKey: string }) {
  const locate = (text: string, data: Record<string, unknown>) => findTextQuote(p.index.text, { quote: text, prefix: String(data.prefix ?? ''), suffix: String(data.suffix ?? ''), offset: Number(data.offset) || 0 })
  return <ContentSurface host={p.host} tabId={p.tabId} surfaceId="text.body" source={p.target} active={p.active}
    revision={String(p.target.blocks.text?.seq ?? p.target.blocks.body?.seq)} root={p.page.parentElement!} version={p.version}
    selected={p.selected} select={p.select} revealId={p.revealId} revealKey={p.revealKey}
    read={() => { const s = selectedText(p.root, p.index); return s && { text: s.text, rect: s.rect, locator: { provider: 'text.quote', version: 1, data: { prefix: s.prefix, suffix: s.suffix, offset: s.from } } } }}
    locate={ref => {
      if (ref.locator.provider !== 'text.quote' || ref.locator.version !== 1) return { status: 'unsupported', rects: [] }
      const at = locate(ref.text, ref.locator.data), range = at && p.index.range(at.from, at.to)
      return { status: range ? 'found' : 'missing', rects: range ? [...range.getClientRects()].map(selectionRect) : [] }
    }}
    reveal={ref => { const at = locate(ref.text, ref.locator.data), range = at && p.index.range(at.from, at.to); if (range) { const el = range.startContainer.parentElement; el?.scrollIntoView({ block: 'center' }) } }} />
}
