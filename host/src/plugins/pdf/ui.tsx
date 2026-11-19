import { PdfOutlineTool } from './outline'
import { pdfLocation } from './selection'
// PDF 插件的界面：检查器分区、阅读状态角标、"PDF"预设视图；双击在阅读器标签页里打开；
// 空格预览、被嵌进文字里时是第一页。封面（缩略图）由预览插件提供，色板由可选插件提供。

import type { InspectorSectionProps, PreviewProps, UiPlugin, ViewProps } from '../../plugin-api/ui/contracts'
import { pdfViewerTabType } from './viewer'
import { readingPosition } from './blocks'
import './badges.css'
import './details.css'

const isPdf = (v: ViewProps['view']) => !!v.blocks.pdf && !!v.blocks.file

/** 点 → 毫米；认得出的常见纸张写上名字。 */
const PAPERS: [string, number, number][] = [
  ['A4', 210, 297],
  ['A3', 297, 420],
  ['A5', 148, 210],
  ['Letter', 216, 279],
  ['Legal', 216, 356]
]
function paperOf(wPt: number, hPt: number): string {
  const w = Math.round((wPt / 72) * 25.4)
  const h = Math.round((hPt / 72) * 25.4)
  const [a, b] = [Math.min(w, h), Math.max(w, h)]
  const named = PAPERS.find(([, pw, ph]) => Math.abs(pw - a) <= 2 && Math.abs(ph - b) <= 2)
  return `${named ? named[0] + ' · ' : ''}${w} × ${h} mm`
}

/** 只投影上次保存的位置，不推断逐页读完、不写入新的完成状态。 */
function savedReading(view: ViewProps['view']) {
  const pages = Number(view.blocks.pdf?.data.pages), reading = view.blocks.pdfreading?.data
  if (!reading || !Number.isInteger(pages) || pages < 1) return
  return { ...readingPosition(reading, pages), pages }
}

function PdfReadingBadge({ view }: ViewProps) {
  const reading = savedReading(view)
  if (!reading || reading.pages === 1) return null
  const end = reading.page === reading.pages
  const label = end ? `上次读到末页 · 共 ${reading.pages} 页` : `上次保存：第 ${reading.page} / ${reading.pages} 页`
  return <span className="badge pdf-reading-badge" data-pdf-reading={end ? 'end' : 'reading'} title={label}>
    {end ? '已读' : `${reading.page} / ${reading.pages} 页`}
  </span>
}

function PdfSection({ view, summarizedFields = [] }: InspectorSectionProps) {
  const p = view.blocks.pdf.data
  const text = view.blocks.pdftext
  const reading = savedReading(view)
  return (
    <dl className="props pdf-props">
      {p.title ? (
        <>
          <dt>标题</dt>
          <dd>{String(p.title)}</dd>
        </>
      ) : null}
      {p.author ? (
        <>
          <dt>作者</dt>
          <dd>{String(p.author)}</dd>
        </>
      ) : null}
      {!summarizedFields.some(field => field.kind === 'pdf' && field.field === 'pages') && <>
        <dt>页数</dt><dd>{String(p.pages)}</dd>
      </>}
      <dt>页面</dt>
      <dd>{paperOf(Number(p.width), Number(p.height))}</dd>
      <dt>文字</dt>
      <dd>{text ? '可以全文搜索' : view.failures['pdf.text'] ? '读不出来' : '没有文字层（可能是扫描版）'}</dd>
      <dt title="上次保存的位置；结束阅读时保存，已打开的页面保留当前位置">阅读进度</dt>
      <dd>{reading ? reading.page === reading.pages ? '已到末页' : `${reading.page} / ${reading.pages} 页` : '尚未查看'}</dd>
    </dl>
  )
}

/** 第一页（代表图）。 */
function FirstPage({ view, host, className, onClick }: ViewProps & { className: string; onClick?(): void }) {
  const still = view.blocks.still
  if (!still) return <div className="preview-status">正在读取…</div>
  return <img className={className} src={host.url(String(still.data.path), still.seq)} draggable={false} alt="" onClick={onClick} />
}

function PdfPreview({ view, host }: PreviewProps) {
  return <FirstPage view={view} host={host} className="preview-img" />
}

function PdfEmbed({ view, host }: ViewProps) {
  return <FirstPage view={view} host={host} className="embed-img embed-pdf" onClick={() => host.open(view.id)} />
}

export const pdfUi: UiPlugin = {
  id: 'pdf',
  contentLocations: [pdfLocation],
  views: [{ id: 'pdfs', title: 'PDF', query: { has: ['pdf'] }, defaultVisible: false, order: 32 }],
  tabTypes: [pdfViewerTabType],
  toolViews: [{ id: 'pdf.outline', title: '文档目录', order: 10, context: { requires: ['pdf.outline'] }, Component: PdfOutlineTool }],
  // 双击：在阅读器里打开，带上打开它的列表（从搜索结果打开时，阅读器翻到命中的那一页）
  opens: [{ id: 'pdf.reader', title: 'PDF 阅读器', priority: 10, match: isPdf, tab: 'pdf.viewer', params: (v, from) => ({ id: v.id, list: from, page: undefined, focus: undefined, request: Date.now() }) }],
  previews: [{ priority: 10, match: isPdf, Component: PdfPreview }],
  embeds: [{ priority: 10, match: isPdf, Component: PdfEmbed }],
  badges: [{ id: 'pdf.reading', order: 50, Component: PdfReadingBadge }],
  sections: [{ id: 'pdf', title: 'PDF', order: 20, kinds: ['pdf', 'pdftext', 'pdfreading'], match: (v) => !!v.blocks.pdf, Component: PdfSection }]
}

export { pdfUi as plugin }
