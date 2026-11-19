import type { ContentLocator } from '../../plugin-api/content-selection'
export interface PdfRect { x: number; y: number; w: number; h: number }
export interface PdfFragment { page: number; quote: string; rects: PdfRect[] }
export function pdfLocationData(locator: ContentLocator): { sourceHash: string; fragments: PdfFragment[] } | undefined {
  if (locator.provider !== 'pdf.quote' || locator.version !== 1) return
  const { sourceHash, fragments } = locator.data
  if (typeof sourceHash !== 'string' || !sourceHash || !Array.isArray(fragments) || !fragments.length) return
  let previous = 0
  for (const f of fragments) {
    if (!Number.isInteger(f?.page) || f.page <= previous || typeof f.quote !== 'string' || !f.quote.trim() || !Array.isArray(f.rects) || !f.rects.length) return
    previous = f.page
    for (const r of f.rects) if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > 1.00001 || r.y + r.h > 1.00001) return
  }
  return { sourceHash, fragments }
}
