import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { PdfFind } from './find'
import { PdfPaperControls, usePdfDefaultPaper } from './paper'
import { usePdfOutline } from './outline'
import { PdfSelection } from './selection'
// PDF 阅读器标签页（设计文档 11.11）：PDF 插件提供的单素材标签页。
// pdf.js 在页面里渲染：竖着连续排，只画看得见的页；有文字层，可以选中、复制。
// 从搜索结果打开时，跳到第一处命中所在的那一页，标出搜到的词（用 PDF 正文块里的分页）。
// ← → 翻页，P / N 在打开它的列表里切换，+ − 缩放，0 适应宽度。

import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EntityView } from '../../shared/blocks'
import { searchTextFor, type Query } from '../../shared/query'
import { searchTerms } from '../../shared/search'
import { markTermsIn } from '../../plugin-api/ui/search'
import { useEntity } from '../../plugin-api/ui/data'
import { useKeys, useUiEffect, useUiFrame } from '../../plugin-api/ui/hooks'
import { useNeighbors, type Neighbors } from '../../plugin-api/ui/navigation'
import type { KeyHandler, PdfPageSurface, TabProps, TabType, UiHost } from '../../plugin-api/ui/contracts'
import { pageAt, readingPosition, type ReadingPosition } from './blocks'
import { savePdfReading, type PdfState } from './reading'
import { Icon } from '../../plugin-api/ui/kit'
import { isEnter } from '../../plugin-api/ui/widgets'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfParams extends Record<string, unknown> {
  id: string
  list?: Query
  /** 打开时翻到这一页。 */
  page?: number
  focus?: string
  /** 区分重复打开同一个摘录与恢复已有工作区。 */
  request?: number
}

/** 页与页之间、页面四周留的空。 */
const GAP = 16
const SIDE = 24
const ZOOMS = [0.25, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4]

interface PageSize { w: number; h: number }
interface Viewport { width: number; height: number; fitWidth: number; inset: number }
function pageScale(size: PageSize, { fitWidth, height, inset }: Viewport, zoom: PdfState['zoom']) {
  if (typeof zoom === 'number') return zoom
  if (!fitWidth || !height) return 1
  const fit = fitWidth / size.w
  return Math.max(.01, zoom === 'fit' ? fit : Math.min(fit, (height - inset * 2) / size.h))
}

function pageIndexAt(tops: number[], y: number) {
  let lo = 0, hi = tops.length
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1
    if (tops[mid] <= y) lo = mid
    else hi = mid
  }
  return lo
}

function Viewer({ params, host, expose, active, visible = active, id: tabId, saved, setState, setParams, setFocus, registerKeys }: TabProps<PdfParams, PdfState>) {
  useUiLocale()
  const view = useEntity(params.id)
  const initialId = useRef(params.id)
  const [selected, setSelected] = useState(params.focus)
  const nav = useNeighbors(host, params.list, params.id, 'pdf')
  useEffect(() => setSelected(params.focus), [params.id, params.focus, params.request])
  useEffect(() => setFocus([selected ?? params.id]), [params.id, selected, setFocus])

  const terms = useMemo(() => searchTerms(searchTextFor(params.list, 'pdftext', 'content')), [params.list])
  const go = (id: string | undefined) => {
    if (id) setParams({ ...params, id, page: undefined, focus: undefined })
  }

  if (!view) return <Status>{uiText("正在读取…")}</Status>
  if (view.deletedAt) {
    return (
      <Status>{uiText("已移到回收站")}{' '}<button className="small" onClick={() => host.core.restore([view.id])}>{uiText("恢复")}{' '}</button>
      </Status>
    )
  }
  if (!view.blocks.file || view.blocks.file.data.ext !== 'pdf') return <Status>{uiText("不是 PDF")}</Status>

  // 翻到哪一页：指定的；从搜索结果打开的，第一处命中所在的页；上次看到的
  const hit = (() => {
    const t = view.blocks.pdftext?.data
    if (!terms.length || !t) return undefined
    const text = String(t.content).toLowerCase()
    const at = Math.min(...terms.map((w) => text.indexOf(w.toLowerCase())).filter((i) => i >= 0))
    return Number.isFinite(at) ? pageAt(t.pages as number[], at) : undefined
  })()
  // 明确要求的（指定页、搜索命中）每次都翻过去；上次看到的只在打开时用
  const target = params.page ?? hit
  const targetKey = `${params.request ?? ''}|${params.page ?? ''}|${params.focus ?? ''}|${terms.join(' ')}`
  const sameDocument = saved?.id === view.id || (!saved?.id && initialId.current === view.id)
  const state = sameDocument && (!saved?.hash || saved.hash === view.blocks.file.data.hash) ? saved : undefined
  const restore = readingPosition(state ? { page: state.page, offset: state.offset } : view.blocks.pdfreading?.data, Number(view.blocks.pdf?.data.pages) || 1)

  return (
    <Document
      key={`${view.id}:${view.blocks.file.data.hash}`}
      tabId={tabId}
      view={view}
      host={host}
      target={target}
      targetKey={targetKey}
      restore={restore}
      resuming={!!state}
      zoom={state?.zoom ?? 'fit'}
      paper={state?.paper ?? 'theme'}
      expose={expose}
      lastRead={state?.lastRead}
      active={active}
      visible={visible}
      selected={selected}
      select={setSelected}
      revealId={params.focus}
      terms={terms}
      nav={nav}
      go={go}
      registerKeys={registerKeys}
      report={setState}
    />
  )
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="pdf-viewer">
      <div className="pdf-scroll">
        <div className="player-status pdf-status">{children}</div>
      </div>
    </div>
  )
}

interface DocumentProps {
  tabId: string
  view: EntityView
  host: UiHost
  /** 要翻到的页（指定的、搜索命中的）；targetKey 变了就再翻一次。 */
  target?: number
  targetKey: string
  /** 没有要求时，打开就翻到这一页（上次看到的）。 */
  restore: ReadingPosition
  resuming: boolean
  active: boolean
  visible: boolean
  selected?: string
  select(id: string | undefined): void
  revealId?: string
  zoom: PdfState['zoom']
  paper: NonNullable<PdfState['paper']>
  expose: TabProps['expose']
  lastRead?: number
  terms: string[]
  nav: Neighbors
  go(id: string | undefined): void
  registerKeys(h: KeyHandler | null): void
  report(s: PdfState): void
}

function Document({ view, host, active, visible, tabId, selected, select, revealId, target, targetKey, restore, resuming, zoom: initialZoom, paper: initialPaper, expose, lastRead: initialRead, terms, nav, go, registerKeys, report }: DocumentProps) {
  useUiLocale()
  const start = resuming ? restore.page : target ?? restore.page
  const initialPosition = useRef({ page: start, offset: resuming || target === undefined ? restore.offset : 0 })
  const [revealRequest, setRevealRequest] = useState(resuming ? undefined : revealId)
  const file = view.blocks.file
  const url = host.url(String(file.data.path), file.seq)
  const [doc, setDoc] = useState<PDFDocumentProxy>()
  const [error, setError] = useState<string>()
  /** 每一页在缩放为 1 时的大小（点）；还没量到的页按第一页算。 */
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [zoom, setZoom] = useState(initialZoom)
  const [paper, setPaper] = useState(initialPaper)
  const defaultPaper = usePdfDefaultPaper(host)
  const [finding, setFinding] = useState(false)
  const reader = useRef<HTMLDivElement>(null)
  const openFind = useCallback(() => {
    setFinding(true)
    const input = reader.current?.querySelector<HTMLInputElement>('.pdf-find input')
    input?.focus()
    input?.select()
  }, [])
  const [page, setPage] = useState(start)
  const readAt = useRef(initialRead)
  const scroller = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0, fitWidth: 0, inset: SIDE })
  const { width, height, inset } = viewport
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [surfaces, setSurfaces] = useState<PdfPageSurface[]>([])
  const layers = host.overlays('pdf')
  const surface = useCallback((n: number, value?: PdfPageSurface) => {
    setSurfaces((old) => [...old.filter((p) => p.page !== n), ...(value ? [value] : [])].sort((a, b) => a.page - b.page))
  }, [])

  useEffect(() => {
    const task = pdfjs.getDocument({
      url,
      // 中文等 CID 字体的字符映射表、标准字体：主进程从 pdfjs-dist 包里供应
      cMapUrl: 'lib://pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'lib://pdfjs/standard_fonts/'
    })
    let alive = true
    task.promise.then(
      async (d) => {
        if (!alive) return
        setDoc(d)
        const out: PageSize[] = []
        for (let i = 1; i <= d.numPages && alive; i++) {
          const v = (await d.getPage(i)).getViewport({ scale: 1 })
          if (!alive) return
          out.push({ w: v.width, h: v.height })
          // 先量到的先用上；全部量完再更新一次
          if (i === 1 || i === d.numPages || i % 50 === 0) setSizes([...out])
        }
      },
      (e: { name?: string; message?: string }) => alive && setError(e.name === 'PasswordException' ? uiText("有密码，打不开") : (e.message ?? uiText("打不开")))
    )
    return () => {
      alive = false
      void task.destroy()
    }
  }, [url])

  useUiEffect(display => {
    const el = scroller.current
    const probe = measure.current
    if (!el || !probe) return
    display.observeResize([el, probe], () => {
      const width = el.clientWidth, height = el.clientHeight, fitWidth = probe.offsetWidth, inset = probe.offsetHeight
      setViewport(old => old.width === width && old.height === height && old.fitWidth === fitWidth && old.inset === inset
        ? old : { width, height, fitWidth, inset })
    })
  }, [])

  const first = sizes[0] ?? { w: 612, h: 792 }
  const count = doc?.numPages ?? 0
  const sizeOf = (i: number) => sizes[i] ?? first
  const scaleOf = (i: number) => pageScale(sizeOf(i), viewport, zoom)
  const scale = scaleOf(page - 1)
  const widest = useMemo(() => sizes.reduce((max, size) => Math.max(max, size.w), first.w), [sizes])
  const sheetWidth = typeof zoom === 'number' ? Math.max(width, Math.ceil(widest * zoom) + inset * 2) : width
  // 拖动捏合时即时缩放画面，停下后再以目标分辨率绘制文字和彩页。
  const [raster, setRaster] = useState({ viewport, zoom })
  useEffect(() => {
    const timer = setTimeout(() => setRaster({ viewport, zoom }), 120)
    return () => clearTimeout(timer)
  }, [viewport, zoom])

  /** 每一页的顶端（相对滚动区域）。 */
  const tops = useMemo(() => {
    const out: number[] = []
    let y = inset
    for (let i = 0; i < count; i++) {
      out.push(y)
      y += sizeOf(i).h * scaleOf(i) + GAP
    }
    return out
  }, [count, sizes, viewport, zoom])

  const keep = useRef(initialPosition.current)
  const programmaticTop = useRef<number>(undefined)
  const scrollTo = useCallback((n: number, offset = 0, record = true) => {
    const el = scroller.current
    const p = Math.max(1, Math.min(count, n))
    if (el && tops[p - 1] !== undefined) {
      el.scrollTop = tops[p - 1] + Math.max(0, Math.min(1, offset)) * sizeOf(p - 1).h * scaleOf(p - 1) - inset / 2
      programmaticTop.current = el.scrollTop
      setPage(p)
      keep.current = { page: p, offset: Math.max(0, Math.min(1, offset)) }
      if (active && record) readAt.current = Date.now()
      report({ id: view.id, hash: String(file.data.hash), ...keep.current, zoom, paper, lastRead: readAt.current })
    }
  }, [count, tops, sizes, width, height, active, view.id, file.data.hash, zoom, paper, report])

  // 打开时翻到起始页（量到那一页之后）；之后又要求翻到某页（例如从搜索结果再打开）时再翻
  const jumped = useRef(false)
  const lastKey = useRef(targetKey)
  useEffect(() => {
    if (!visible || !count || sizes.length < Math.min(initialPosition.current.page, count) || !width) return
    if (!jumped.current) {
      jumped.current = true
      scrollTo(initialPosition.current.page, initialPosition.current.offset, !resuming)
    } else if (targetKey !== lastKey.current) {
      setRevealRequest(revealId)
      if (target !== undefined) scrollTo(target)
    }
    lastKey.current = targetKey
  }, [visible, count, sizes.length, width, target, targetKey, revealId, scrollTo])

  const outline = usePdfOutline(doc, scrollTo)
  const title = host.title(view)
  useEffect(() => {
    expose({ find: openFind, context: { title, capabilities: outline ? { 'pdf.outline': outline } : undefined } })
    return () => expose(null)
  }, [expose, title, outline, openFind])

  const anchor = useRef<{ i: number; x: number; y: number; px: number; py: number; target: number }>(undefined)
  function changeZoom(next: PdfState['zoom'], px = width / 2, py = height / 2) {
    const el = scroller.current
    if (!el || !tops.length || next === zoom) return
    const i = pageIndexAt(tops, el.scrollTop + py)
    const size = sizeOf(i), pageZoom = scaleOf(i)
    anchor.current = { i, px, py, target: typeof next === 'number' ? next : scale,
      x: (el.scrollLeft + px - (sheetWidth - size.w * pageZoom) / 2) / pageZoom,
      y: (el.scrollTop + py - tops[i]) / pageZoom }
    setZoom(next)
  }
  useLayoutEffect(() => {
    if (!visible || !jumped.current || !scroller.current) return
    const a = anchor.current
    if (a && tops[a.i] !== undefined) {
      const el = scroller.current
      const newScale = scaleOf(a.i)
      el.scrollLeft = (sheetWidth - sizeOf(a.i).w * newScale) / 2 + a.x * newScale - a.px
      el.scrollTop = tops[a.i] + a.y * newScale - a.py
      programmaticTop.current = el.scrollTop
      anchor.current = undefined
    } else scrollTo(keep.current.page, keep.current.offset, false)
  }, [zoom, visible, viewport, sizes])

  const wheel = useRef<(e: WheelEvent) => void>(() => {})
  wheel.current = e => {
    if ((!e.ctrlKey && !e.metaKey) || !e.cancelable) return
    e.preventDefault()
    if (!e.deltaY) return
    const el = scroller.current!
    const rect = el.getBoundingClientRect()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1
    const i = pageIndexAt(tops, el.scrollTop + e.clientY - rect.top)
    const next = (anchor.current?.target ?? scaleOf(i)) * Math.exp(-e.deltaY * unit * .006)
    changeZoom(Math.min(4, Math.max(.25, next)), e.clientX - rect.left, e.clientY - rect.top)
  }
  useUiEffect(display => {
    if (scroller.current) display.on(scroller.current, 'wheel', e => wheel.current(e), { passive: false })
  }, [])

  const onScroll = () => {
    const el = scroller.current
    if (!el || !jumped.current || !visible || !width) return
    const y = el.scrollTop + inset / 2
    const p = pageIndexAt(tops, y + .5) + 1
    if (p !== page) setPage(p)
    const fraction = Math.max(0, Math.min(1, (y - tops[p - 1]) / (sizeOf(p - 1).h * scaleOf(p - 1))))
    if (active && el.scrollTop !== programmaticTop.current && (keep.current.page !== p || Math.abs(keep.current.offset - fraction) > .001)) readAt.current = Date.now()
    programmaticTop.current = undefined
    keep.current = { page: p, offset: fraction }
    report({ id: view.id, hash: String(file.data.hash), ...keep.current, zoom, paper, lastRead: readAt.current })
  }

  useEffect(() => { if (jumped.current && visible) report({ id: view.id, hash: String(file.data.hash), ...keep.current, zoom, paper, lastRead: readAt.current }) }, [view.id, file.data.hash, visible, zoom, paper, report])

  const zoomBy = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > scale + 0.01) : [...ZOOMS].reverse().find((z) => z < scale - 0.01)
    if (next) changeZoom(next)
  }

  useKeys(registerKeys, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
    switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
      case 'Escape':
        if (finding) { setFinding(false); return true }
        if (selected) { select(undefined); return true }
        return false
      case 'ArrowLeft':
        scrollTo(page - 1)
        return true
      case 'ArrowRight':
        scrollTo(page + 1)
        return true
      case 'Home':
        scrollTo(1)
        return true
      case 'End':
        scrollTo(count)
        return true
      case 'p':
        go(nav.prev)
        return true
      case 'n':
        go(nav.next)
        return true
      case '=':
      case '+':
        zoomBy(1)
        return true
      case '-':
        zoomBy(-1)
        return true
      case '0':
        changeZoom('fit')
        return true
    }
    return false
  })

  return (
    <div className="pdf-viewer" ref={reader} data-paper={paper === 'theme' ? defaultPaper.value : paper}>
      <div className="pdf-bar" role="toolbar" aria-label={uiText("PDF 阅读工具")}>
        {nav.total > 1 && nav.index >= 0 && <div className="pdf-control-group pdf-queue" aria-label={uiText("文件队列")}>
          <button aria-label={uiText("上一个文件")} title={uiText("上一个文件（P）")} disabled={!nav.prev} onClick={() => go(nav.prev)}><Icon name="left" size={14} /></button>
          <span title={uiText("当前文件在队列中的位置")}>{nav.index + 1} / {nav.total}</span>
          <button aria-label={uiText("下一个文件")} title={uiText("下一个文件（N）")} disabled={!nav.next} onClick={() => go(nav.next)}><Icon name="right" size={14} /></button>
        </div>}
        {count > 0 && <div className="pdf-control-group">
          <button aria-label={uiText("上一页")} title={uiText("上一页（←）")} disabled={page <= 1} onClick={() => scrollTo(page - 1)}><Icon name="up" size={14} /></button>
          <PageJump page={page} count={count} onJump={scrollTo} />
          <button aria-label={uiText("下一页")} title={uiText("下一页（→）")} disabled={page >= count} onClick={() => scrollTo(page + 1)}><Icon name="down" size={14} /></button>
        </div>}
        <div className="pdf-control-group pdf-zoom">
          <button aria-label={uiText("缩小")} title={uiText("缩小（−）")} disabled={scale <= ZOOMS[0]} onClick={() => zoomBy(-1)}><Icon name="minus" size={14} /></button>
          <select aria-label={uiText("页面缩放")} title={uiText("页面缩放")} value={typeof zoom === 'number' ? scale : zoom}
            onChange={e => changeZoom(e.target.value === 'fit' || e.target.value === 'page' ? e.target.value : Number(e.target.value))}>
            <option value="fit">{uiText("适应宽度")}</option><option value="page">{uiText("适应整页")}</option>
            {typeof zoom === 'number' && !ZOOMS.includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
            {ZOOMS.map(z => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          </select>
          <button aria-label={uiText("放大")} title={uiText("放大（+）")} disabled={scale >= ZOOMS[ZOOMS.length - 1]} onClick={() => zoomBy(1)}><Icon name="plus" size={14} /></button>
        </div>
        <div className="pdf-control-group pdf-tools">
          {outline && <button title={uiText("打开文档目录")} onClick={() => host.showView('pdf.outline')}>{uiText("目录")}</button>}
          <button title={uiText("在此 PDF 中查找（⌘/Ctrl F）")} aria-expanded={finding} onClick={openFind}>{uiText("查找")}</button>
          <PdfPaperControls host={host} paper={paper} change={setPaper} />
        </div>
        {selected && <button title={uiText("取消摘录选择，查看原文详情")} onClick={() => select(undefined)}>{uiText("返回原文")}</button>}
      </div>
      {finding && doc && <PdfFind doc={doc} surfaces={surfaces} jump={scrollTo} close={() => { setFinding(false); scroller.current?.focus() }} />}
      <div className="pdf-scroll" data-hy-part="reader-page" data-hy-reader="pdf" tabIndex={-1} ref={scroller} onScroll={onScroll}>
        <div aria-hidden="true" className="pdf-fit-measure" ref={measure} />
        {error ? (
          <div className="player-status pdf-status">{uiText("打不开：")}{error}</div>
        ) : !doc ? (
          <div className="player-status pdf-status">{uiText("正在打开…")}</div>
        ) : (
          <div className="pdf-pages" ref={setRoot} style={{ width: sheetWidth, height: (tops[count - 1] ?? 0) + Math.max(sizeOf(count - 1).h * scaleOf(count - 1) + inset, height - inset / 2) }}>
            {tops.map((top, i) => (
              <Page key={i} doc={doc} n={i + 1} top={top} size={sizeOf(i)} scale={scaleOf(i)} rasterScale={pageScale(sizeOf(i), raster.viewport, raster.zoom)} root={scroller} terms={terms} surface={surface} />
            ))}
            {root && !layers.some(o=>o.selection!=='shared') && <PdfSelection tabId={tabId} target={view} host={host} active={active} root={root} pages={surfaces} selected={selected} select={select} revealId={revealRequest} revealKey={targetKey} reveal={scrollTo}/>}
            {root && layers.map((layer) => <layer.Component key={layer.id} target={view} host={host} active={active} root={root} pages={surfaces} selected={selected} select={select} revealId={revealRequest} revealKey={targetKey} reveal={scrollTo} />)}
          </div>
        )}
      </div>
    </div>
  )
}

/** 页码就地编辑：回车跳转，Esc 或失焦取消；输入过程不改变阅读位置。 */
function PageJump({ page, count, onJump }: { page: number; count: number; onJump(page: number): void }) {
  useUiLocale()
  const [draft, setDraft] = useState<string>()
  const [invalid, setInvalid] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const nextFrame = useUiFrame()
  const finish = () => {
    setDraft(undefined)
    nextFrame(() => button.current?.focus())
  }
  if (draft === undefined) return (
    <button ref={button} className="player-time pdf-page-jump" title={uiText("点击输入页码跳转；← → 翻页")} aria-label={uiText("当前第 {page} 页，共 {count} 页，点击跳页", { page, count })}
      onClick={() => { setDraft(String(page)); setInvalid(false) }}>
      {page} / {count}{' '}{uiText("页")}{' '}</button>
  )
  return (
    <span className="player-time pdf-page-editor">
      <input aria-label={uiText("跳转页码")} aria-invalid={invalid} title={invalid ? uiText("请输入整数页码") : uiText("输入 1–{count}，回车跳转，Esc 取消", { count })}
        inputMode="numeric" autoFocus value={draft} style={{ width: `${Math.max(3, String(count).length + 1)}ch` }}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
        onBlur={() => setDraft(undefined)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (isEnter(e)) {
            e.preventDefault()
            const n = Number(draft.trim())
            if (!draft.trim() || !Number.isSafeInteger(n)) { setInvalid(true); return }
            onJump(Math.max(1, Math.min(count, n)))
            finish()
          } else if (e.key === 'Escape') { e.preventDefault(); finish() }
        }} />
      <span>/ {count}{' '}{uiText("页")}</span>
    </span>
  )
}

/** 一页：滚到附近才画；缩放了重画。画面一层，文字一层（可以选中）。 */
function Page({ doc, n, top, size, scale, rasterScale, root, terms, surface }: { doc: PDFDocumentProxy; n: number; top: number; size: PageSize; scale: number; rasterScale: number; root: React.RefObject<HTMLDivElement | null>; terms: string[]; surface(n: number, value?: PdfPageSurface): void }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textLayer = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useUiEffect(display => {
    const el = box.current
    if (!el || !root.current) return
    display.observeIntersection(el, ([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: '100% 0px' })
  }, [root])

  // 离开可视区后仍保留已画好的文字层，长选区会用到。只有内容或比例变化才使坐标失效。
  useEffect(() => () => surface(n), [doc, n, rasterScale, terms, surface])

  useEffect(() => {
    if (!near) {
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0 }
      return
    }
    let task: RenderTask | undefined
    let layerTask: pdfjs.TextLayer | undefined
    let alive = true
    void (async () => {
      const p = await doc.getPage(n)
      if (!alive || !canvas.current || !textLayer.current) return
      const viewport = p.getViewport({ scale: rasterScale })
      const c = canvas.current
      const ratio = Math.min(c.ownerDocument.defaultView?.devicePixelRatio || 1, 8192 / Math.max(viewport.width, viewport.height), Math.sqrt(16_000_000 / (viewport.width * viewport.height)))
      c.width = Math.floor(viewport.width * ratio)
      c.height = Math.floor(viewport.height * ratio)
      task = p.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      try {
        await task.promise
      } catch {
        return // 缩放时取消了
      }
      if (!alive || !textLayer.current) return
      const layer = textLayer.current
      layer.replaceChildren()
      layerTask = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: layer, viewport })
      await layerTask.render()
      if (alive && terms.length) markTermsIn(layer, terms)
      if (alive && box.current) surface(n, { page: n, element: box.current, textLayer: layer })
    })().catch((error) => { if (alive) console.error('PDF 页面渲染失败', error) })
    return () => {
      alive = false
      task?.cancel()
      layerTask?.cancel()
    }
  }, [near, doc, n, rasterScale, terms, surface])

  return (
    <div
      ref={box}
      className="pdf-page"
      data-page={n}
      style={{ top, width: size.w * scale, height: size.h * scale, ['--scale-factor' as string]: scale, ['--total-scale-factor' as string]: scale, ['--user-unit' as string]: 1 }}
    >
      <canvas ref={canvas} style={{ width: size.w * scale, height: size.h * scale }} />
      <div ref={textLayer} className="textLayer" />
    </div>
  )
}

function ViewerTitle({ params, host }: { params: PdfParams; host: UiHost }) {
  const view = useEntity(params.id)
  return <>{view ? host.title(view) : 'PDF'}</>
}

export const pdfViewerTabType: TabType<PdfParams, PdfState> = {
  id: 'pdf.viewer',
  instances: { scope: 'content' },
  Title: ViewerTitle,
  Component: Viewer,
  beforeLeave: savePdfReading,
  // 普通打开定位已有阅读器；显式多视图各自保存阅读位置
  key: (params) => params.id
}
