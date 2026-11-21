import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ToolViewProps } from '../../plugin-api/ui/contracts'

type Entry = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number]
interface Outline {
  entries: Entry[]
  visit(entry: Entry): Promise<boolean>
}

export function usePdfOutline(doc: PDFDocumentProxy | undefined, jump: (page: number, offset?: number) => void) {
  const [entries, setEntries] = useState<Entry[]>([])
  const latestJump = useRef(jump)
  latestJump.current = jump
  const revision = useRef(0)
  useEffect(() => {
    let live = true
    setEntries([])
    doc?.getOutline().then(items => { if (live) setEntries(items ?? []) }, () => {})
    return () => { live = false; revision.current++ }
  }, [doc])

  return useMemo((): Outline | undefined => doc && entries.length ? {
    entries,
    async visit(entry) {
      const ticket = ++revision.current
      try {
        const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest
        if (!dest) return false
        const index = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0])
        const page = await doc.getPage(index + 1)
        const viewport = page.getViewport({ scale: 1 })
        const type = dest[1]?.name
        const top = type === 'XYZ' ? dest[3] : type === 'FitH' || type === 'FitBH' ? dest[2] : type === 'FitR' ? dest[5] : null
        const left = type === 'XYZ' || type === 'FitR' ? dest[2] : null
        const offset = Number.isFinite(top) ? viewport.convertToViewportPoint(left ?? page.view[0], top)[1] / viewport.height : 0
        if (ticket === revision.current) latestJump.current(index + 1, offset)
        return true
      } catch { return false }
    }
  } : undefined, [doc, entries])
}

function Branch({ entry, visit }: { entry: Entry; visit(entry: Entry): void }) {
  useUiLocale()
  const [expanded, setExpanded] = useState(false)
  const children = entry.items?.length > 0
  return <li>
    <div className="pdf-outline-row">
      {children && <button className="pdf-outline-toggle" aria-label={expanded ? uiText("折叠章节") : uiText("展开章节")} aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'}</button>}
      <button className="pdf-outline-entry" disabled={!entry.dest && !children} title={entry.title}
        onClick={() => entry.dest ? visit(entry) : setExpanded(!expanded)}>{entry.title || uiText("未命名章节")}</button>
    </div>
    {children && expanded && <ul>{entry.items.map((child, i) => <Branch key={i} entry={child} visit={visit} />)}</ul>}
  </li>
}

export function PdfOutlineTool({ context }: ToolViewProps) {
  useUiLocale()
  const outline = context?.capabilities['pdf.outline'] as Outline | undefined
  const [error, setError] = useState(false)
  if (!outline) return null
  const visit = async (entry: Entry) => {
    if (context?.isAvailable()) setError(!await outline.visit(entry))
  }
  return <nav aria-label={uiText("文档目录")} className="pdf-outline">
    <ul>{outline.entries.map((entry, i) => <Branch key={i} entry={entry} visit={visit} />)}</ul>
    {error && <p role="status">{uiText("无法定位此章节。")}</p>}
  </nav>
}
