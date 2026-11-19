import { selectionActions, ContentMarks, contentReference } from './selection'
// 批注插件的界面（设计文档 11.2）：
// 在图片查看器的叠加层上拖出一块区域，或者在播放器的时间轴上标出一段，写一句话（#标签 变成标签），
// 回车——这一部分成为一个身份。原素材的检查器列出它的批注；局部有自己的卡片（裁好的封面、起点那一帧）；
// 打开局部 = 打开原素材并定位到那一部分。

import { useEffect, useRef, useState } from 'react'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import { useEntity } from '@resource-manager/plugin-api/ui/data'
import { useKeys } from '@resource-manager/plugin-api/ui/hooks'
import type { RegionOverlayProps, TimelineOverlayProps, UiHost, UiPlugin, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { formatDuration, isEnter } from '@resource-manager/plugin-api/ui/widgets'
import { annotationBlocks, firstLine, isPdfQuote, isQuote, isTextRange, labelOf, quoteOf, useLocals } from './common'
import { TextRangeLayer } from './text'
import { PdfQuoteLayer } from './pdf'
import type { PdfFragment } from './blocks'
import './styles.css'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Span {
  start: number
  end: number
}

/** 小于这么多屏幕像素的拖动当作点击（取消选中），不当作圈选。 */
const MIN_DRAG = 6
/** 按键标记的片段至少这么长（秒）。 */
const MIN_SPAN = 0.2

const clamp = (v: number) => Math.max(0, Math.min(1, v))
const pct = (v: number) => `${v * 100}%`
const rectOf = (v: EntityView | undefined): Rect | undefined => {
  const a = v?.blocks.anchor?.data
  return a ? { x: Number(a.x), y: Number(a.y), w: Number(a.w), h: Number(a.h) } : undefined
}
const spanOf = (v: EntityView | undefined): Span | undefined => {
  const a = v?.blocks.anchor?.data
  return a?.type === '时间段' ? { start: Number(a.start), end: Number(a.end) } : undefined
}
const isSegment = (v: EntityView) => v.blocks.anchor?.data.type === '时间段'
const rangeText = (s: Span) => `${formatDuration(s.start)} – ${formatDuration(s.end)}`
// ---------- 查看器上的叠加层 ----------

function RegionLayer({ target, host, selected, select, reveal, revealId }: RegionOverlayProps) {
  const locals = useLocals(host, target.id)
  const layer = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Rect>()
  const [drawing, setDrawing] = useState(false)
  const [text, setText] = useState('')
  // 拖动中的状态放在引用里：移动事件很密，不等界面重绘也要读到最新的起点和区域
  const drag = useRef<{ x: number; y: number; rect: Rect } | null>(null)

  const point = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect()
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height), px: r.width, py: r.height }
  }

  const submit = async () => {
    if (!draft) return
    const imgW = Number(target.blocks.image?.data.width) || 1
    const imgH = Number(target.blocks.image?.data.height) || 1
    const id = await host.core.create({
      anchor: { target: target.id, type: '图片区域', ...draft, aspect: (draft.w * imgW) / (draft.h * imgH) },
      ...annotationBlocks(host, text)
    })
    setDraft(undefined)
    setText('')
    select(id)
  }

  return (
    <div
      className="region-layer"
      ref={layer}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.target !== e.currentTarget) return
        // 拖出图片外面也继续跟着（拿不到指针时不影响圈选）
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // 例如合成的指针事件
        }
        const p = point(e)
        drag.current = { x: p.x, y: p.y, rect: { x: p.x, y: p.y, w: 0, h: 0 } }
        setDraft(drag.current.rect)
        setDrawing(true)
        setText('')
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const p = point(e)
        d.rect = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) }
        setDraft(d.rect)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        if (!d) return
        drag.current = null
        setDrawing(false)
        const p = point(e)
        // 几乎没拖动：是点击空白处，取消选中
        if (d.rect.w * p.px < MIN_DRAG || d.rect.h * p.py < MIN_DRAG) {
          setDraft(undefined)
          select(undefined)
        }
      }}
    >
      {locals.map((id) => (
        <RegionBox key={id} id={id} host={host} selected={id === selected} select={select} reveal={id === revealId ? reveal : undefined} />
      ))}
      {draft && <div className="region draft" style={{ left: pct(draft.x), top: pct(draft.y), width: pct(draft.w), height: pct(draft.h) }} />}
      {draft && !drawing && (
        <div className="region-input" style={{ left: pct(draft.x), top: pct(Math.min(draft.y + draft.h, 0.92)) }} onPointerDown={(e) => e.stopPropagation()}>
          <input
            className="field-text"
            autoFocus
            value={text}
            placeholder="写点什么，#标签，回车；Esc 取消"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (isEnter(e)) void submit()
              else if (e.key === 'Escape') setDraft(undefined)
            }}
          />
        </div>
      )}
    </div>
  )
}

/** 一个局部的框：标签是笔记的第一行。选中时可以删掉。 */
function RegionBox({ id, host, selected, select, reveal }: { id: string; host: UiHost; selected: boolean; select(id: string): void; reveal?(r: Rect): void }) {
  const view = useEntity(id)
  const rect = rectOf(view)
  // 从局部的卡片打开查看器：找到它的区域后放大过去，只做一次
  const revealed = useRef(false)
  useEffect(() => {
    if (reveal && rect && !revealed.current) {
      revealed.current = true
      reveal(rect)
    }
  }, [reveal, rect])
  if (!rect) return null
  const label = labelOf(view)
  return (
    <div
      className={`region${selected ? ' selected' : ''}`}
      style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
      onPointerDown={(e) => {
        e.stopPropagation()
        select(id)
      }}
    >
      {label && <span className="region-label">{label}</span>}
      {selected && (
        <button className="region-x" title="删除这条批注（可以撤销）" onPointerDown={(e) => e.stopPropagation()} onClick={() => host.core.trash([id])}>
          ×
        </button>
      )}
    </div>
  )
}

// ---------- 播放器时间轴上的叠加层 ----------

/**
 * 时间轴上方的一条：已有的片段显示成色条；拖出一段，或者边看边按 I（起点）、O（终点），写一句话，回车。
 * 写的时候暂停，写完接着放。
 */
function SegmentLayer({ target, host, duration, time, playing, seek, play, pause, reveal, selected, select, revealId, registerKeys }: TimelineOverlayProps) {
  const locals = useLocals(host, target.id)
  const lane = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Span>()
  /** 按了 I：起点定下，终点跟着播放位置走。 */
  const [markFrom, setMarkFrom] = useState<number>()
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const drag = useRef<{ from: number; x: number } | null>(null)
  /** 开始标记时在播放：写完接着放。 */
  const resume = useRef(false)

  const timeAt = (clientX: number) => {
    const r = lane.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width) * duration
  }
  const ordered = (a: number, b: number): Span => ({ start: Math.min(a, b), end: Math.max(a, b) })
  const round = (t: number) => Math.round(t * 1000) / 1000

  const write = (span: Span) => {
    setDraft(span)
    setMarkFrom(undefined)
    setWriting(true)
    setText('')
    pause()
  }
  const done = () => {
    setDraft(undefined)
    setMarkFrom(undefined)
    setWriting(false)
    setText('')
    if (resume.current) play()
    resume.current = false
  }

  const submit = async () => {
    if (!draft) return
    const v = target.blocks.video?.data
    const id = await host.core.create({
      anchor: { target: target.id, type: '时间段', start: round(draft.start), end: round(draft.end), aspect: Number(v?.width) / Number(v?.height) || 1 },
      ...annotationBlocks(host, text)
    })
    select(id)
    done()
  }

  useKeys(registerKeys, (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    const key = e.key.toLowerCase()
    if (key === 'i') {
      resume.current = playing
      setDraft(undefined)
      setWriting(false)
      setMarkFrom(time)
      return true
    }
    if (key === 'o' && markFrom !== undefined) {
      if (Math.abs(time - markFrom) >= MIN_SPAN) write(ordered(markFrom, time))
      return true
    }
    if (e.key === 'Escape' && (markFrom !== undefined || draft)) {
      done()
      return true
    }
    return false
  })

  const live = markFrom !== undefined ? ordered(markFrom, time) : draft
  const at = (t: number) => pct(duration ? clamp(t / duration) : 0)

  return (
    <div
      className="segment-layer"
      ref={lane}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.target !== e.currentTarget || !duration) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // 例如合成的指针事件
        }
        const t = timeAt(e.clientX)
        drag.current = { from: t, x: e.clientX }
        resume.current = playing || resume.current
        pause()
        setMarkFrom(undefined)
        setWriting(false)
        setDraft({ start: t, end: t })
        seek(t)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const t = timeAt(e.clientX)
        setDraft(ordered(d.from, t))
        // 拖的时候画面跟着走，看得到起止是哪一帧
        seek(t)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        if (!d) return
        drag.current = null
        // 几乎没拖动：是点一下，跳到那里，取消选中
        if (Math.abs(e.clientX - d.x) < MIN_DRAG) {
          select(undefined)
          done()
        } else write(ordered(d.from, timeAt(e.clientX)))
      }}
    >
      {!locals.length && !live && <span className="segment-hint">拖出一段，或者按 I / O 标记起止，可以批注</span>}
      {locals.map((id) => (
        <SegmentBar key={id} id={id} host={host} duration={duration} selected={id === selected} select={select} seek={seek} reveal={id === revealId ? reveal : undefined} />
      ))}
      {live && <div className={`segment draft${markFrom !== undefined ? ' marking' : ''}`} style={{ left: at(live.start), width: at(live.end - live.start) }} />}
      {writing && draft && (
        <div className="segment-input" style={{ left: `clamp(0px, ${at(draft.start)}, calc(100% - 320px))` }} onPointerDown={(e) => e.stopPropagation()}>
          <span className="segment-range">{rangeText(draft)}</span>
          <input
            className="field-text"
            autoFocus
            value={text}
            placeholder="写点什么，#标签，回车；Esc 取消"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (isEnter(e)) void submit()
              else if (e.key === 'Escape') done()
            }}
          />
        </div>
      )}
    </div>
  )
}

/** 一个片段的色条：点一下选中并跳到起点。选中时上方显示它的笔记，可以删掉。 */
function SegmentBar(p: { id: string; host: UiHost; duration: number; selected: boolean; select(id: string): void; seek(t: number): void; reveal?(t: number): void }) {
  const view = useEntity(p.id)
  const span = spanOf(view)
  // 从片段的卡片打开播放器：跳到起点，只做一次
  const revealed = useRef(false)
  const start = span?.start
  const { reveal } = p
  useEffect(() => {
    if (reveal && start !== undefined && !revealed.current) {
      revealed.current = true
      reveal(start)
    }
  }, [reveal, start])
  if (!span || !p.duration) return null
  const label = labelOf(view, 40)
  const left = span.start / p.duration
  return (
    <div
      className={`segment${p.selected ? ' selected' : ''}`}
      style={{ left: pct(clamp(left)), width: pct(clamp((span.end - span.start) / p.duration)) }}
      title={`${rangeText(span)}  ${label}`}
      onPointerDown={(e) => {
        e.stopPropagation()
        p.select(p.id)
        p.seek(span.start)
      }}
    >
      {p.selected && (
        <div className={`segment-chip${left > 0.6 ? ' flip' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
          <span className="segment-range">{rangeText(span)}</span>
          <span className="segment-label">{label || <span className="muted">（没写字）</span>}</span>
          <button className="segment-x" title="删除这条批注（可以撤销）" onClick={() => p.host.core.trash([p.id])}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- 检查器 ----------

/** 局部是哪一种：图片区域、时间段、文本区间、PDF 摘录。 */
const isRegion = (v: EntityView) => v.blocks.anchor?.data.type === '图片区域'
const pdfPages = (v: EntityView) => {
  if (!isPdfQuote(v)) return ''
  const parts = v.blocks.anchor.data.fragments as PdfFragment[]
  return parts.length > 1 ? `第 ${parts[0].page}–${parts[parts.length - 1].page} 页` : `第 ${parts[0].page} 页`
}
/** 失配：原文改了，找不到这一句（由认识原素材的插件检查，见定位块）。 */
const lost = (v: EntityView) => v.blocks.place?.data.found === false

/** 原素材的检查器：它的批注（经由依附引用）。 */
function AnnotationsSection({ view, host }: ViewProps) {
  const locals = useLocals(host, view.id)
  if (!locals.length) {
    const hint = view.blocks.video
      ? ['在播放器的时间轴上方拖出一段，或者按 I / O 标记起止，就能批注这一段。', '打开播放器']
      : view.blocks.image
        ? ['在图片查看器里拖出一块区域，就能批注这一块。', '打开查看器']
        : view.blocks.pdf
          ? ['在 PDF 阅读器里选中文字，就能保存摘录标记，也可以添加批注和标签。', '打开阅读器']
          : ['在阅读器里选中文字，通过选区菜单标记摘录或添加批注。', '打开']
    return (
      <div className="muted annotate-hint">
        {hint[0]}
        <button className="link" onClick={() => host.open(view.id)}>
          {hint[1]}
        </button>
      </div>
    )
  }
  return (
    <div className="annotations">
      {locals.map((id) => (
        <LocalRow key={id} id={id} host={host} />
      ))}
    </div>
  )
}

function LocalRow({ id, host }: { id: string; host: UiHost }) {
  const view = useEntity(id)
  if (!view) return null
  const thumb = view.blocks.thumb
  const tags = (view.blocks.tags?.data.values as string[] | undefined) ?? []
  const span = spanOf(view)
  const quote = quoteOf(view)
  const where = isPdfQuote(view) ? '在 PDF 中定位到摘录' : span ? '在播放器里从这一段开始' : quote ? '在原文中定位到摘录' : '在查看器里定位到这一块'
  return (
    <button className={`local-row${lost(view) ? ' lost' : ''}`} title={where} onClick={() => host.open(id)}>
      <span className="local-thumb">
        {thumb ? <img src={host.url(String(thumb.data.path), thumb.seq)} alt="" /> : quote ? <span className="link-row-icon">“</span> : null}
      </span>
      <span className="local-text">
        <span>{firstLine(view.blocks.note?.data.text, 40) || (quote ? `“${firstLine(quote.quote, 40)}”` : <span className="muted">（没写字）</span>)}</span>
        {(span || quote || tags.length > 0) && (
          <span className="muted">
            {span && rangeText(span)}
            {isPdfQuote(view) && `${pdfPages(view)} `}
            {quote && view.blocks.note && `“${firstLine(quote.quote, 24)}”`}
            {lost(view) && ' 原文已改'}
            {(span || quote) && tags.length > 0 && '  '}
            {tags.map((t) => `#${t}`).join(' ')}
          </span>
        )}
      </span>
    </button>
  )
}

/** 局部的检查器：它是哪个素材的哪一部分。文本区间显示原来的那一句；原文改了找不到时说一声。 */
function LocalSection({ view, host }: ViewProps) {
  const targetId = String(view.blocks.anchor.data.target)
  const target = useEntity(targetId)
  const span = spanOf(view)
  const quote = quoteOf(view)
  const where = isPdfQuote(view) ? '在 PDF 中定位到摘录' : span ? '在播放器里从这一段开始' : quote ? '在原文中定位到摘录' : '在查看器里定位到这一块'
  return (
    <>
      <div className="annotate-source">
        来自
        <button className="link" title={where} onClick={() => host.open(view.id)}>
          {target ? host.title(target) : '（原素材找不到了）'}
        </button>
        {span && <span className="muted"> {rangeText(span)}</span>}
        {isPdfQuote(view) && <span className="muted"> {pdfPages(view)}</span>}
        {target?.deletedAt ? <span className="muted">（在回收站里）</span> : null}
      </div>
      {quote && <blockquote className="local-quote">{quote.quote}</blockquote>}
      {lost(view) && <div className="local-lost">{isPdfQuote(view) ? '原 PDF 已变化，请核对摘录位置。' : '原文改过了，找不到这一句。'}上面是当时划下的原文。</div>}
    </>
  )
}

/** 嵌在文字里的图片局部：裁好的那一块，点一下在查看器里放大到它。 */
function RegionEmbed({ view, host }: ViewProps) {
  const still = view.blocks.still
  if (!still) return <span className="embed-loading" />
  return <img className="embed-img" src={host.url(String(still.data.path), still.seq)} alt="" title="在查看器中定位到这一块" onClick={() => host.open(view.id)} />
}

/** 摘句的卡片：那一句本身（短的当引文，长的照常排）。 */
function QuoteCover({ view }: ViewProps) {
  const q = quoteOf(view)?.quote ?? ''
  return <div className={`cover-text${q.length <= 80 ? ' cover-quote' : ''}`}>{q}</div>
}

/** 嵌在文字里的摘句：引用那一句，点一下回到原文的那一处。 */
function QuoteEmbed({ view, host }: ViewProps) {
  return (
    <span className="embed-quote" title="在原文里定位到这一句" onClick={() => host.open(view.id)}>
      {quoteOf(view)?.quote}
    </span>
  )
}

export const annotateUi: UiPlugin = {
  id: 'annotate',
  selectionActions,
  selectionLayers: [{id:'annotate.content-marks',order:10,Component:ContentMarks}],
  // 图片查看器上圈一块，播放器时间轴上标一段，文字里划一句。哪个媒体插件没启用，对应的叠加层就不出现
  overlays: [
    { id: 'regions', needs: ['image'], order: 10, space: 'region', Component: RegionLayer },
    { id: 'segments', needs: ['video'], order: 10, space: 'timeline', Component: SegmentLayer },
    { id: 'texts', needs: ['text'], order: 10, space: 'text', selection: 'shared', Component: TextRangeLayer },
    { id: 'pdf-quotes', needs: ['pdf'], order: 10, space: 'pdf', selection: 'shared', Component: PdfQuoteLayer }
  ],
  sections: [
    { id: 'local', title: '局部', order: 5, kinds: ['anchor', 'place'], Component: LocalSection },
    {
      id: 'annotations',
      title: '批注',
      order: 25,
      kinds: [],
      match: (v,ctx) => !!v.blocks.image || !!v.blocks.video || ctx.hasContentLocation(v),
      Component: AnnotationsSection
    }
  ],
  // 局部的标题：笔记的第一行；摘句没写笔记时就是那一句
  titles: [
    {
      priority: 5,
      get: (v) => {
        if (!v.blocks.anchor) return undefined
        const note = firstLine(v.blocks.note?.data.text, 40)
        if (note) return note
        return isSegment(v) ? '视频片段' : isQuote(v) ? firstLine(quoteOf(v)?.quote, 40) || '摘句' : '图片局部'
      }
    }
  ],
  covers: [{ priority: 5, match: isQuote, Component: QuoteCover }],
  // 片段的嵌入由视频插件提供（它会播）；图片局部是裁好的那一块；摘句是那一句
  embeds: [
    { priority: 10, match: isRegion, Component: RegionEmbed },
    { priority: 10, match: isQuote, Component: QuoteEmbed }
  ],
  // 片段的角标带上它有多长，和视频卡片的时长角标一样；原文改得找不到了标出来
  badges: [
    {
      order: 5,
      get: (v) => {
        if (!v.blocks.anchor) return undefined
        const span = spanOf(v)
        return span ? { text: `片段 ${formatDuration(span.end - span.start)}` } : { text: isPdfQuote(v) ? `PDF 摘录 · ${pdfPages(v)}` : isQuote(v) ? '摘句' : '局部' }
      }
    },
    { order: 6, get: (v) => (v.blocks.anchor && lost(v) ? { text: '原文已改', color: '#c0392b' } : undefined) }
  ],
  // 打开局部 = 打开原素材并定位：图片放大到那一块，视频跳到那一段的起点，文字滚到那一句
  opens: [
    {priority:4,match:v=>!!contentReference(v),open:(v,host)=>host.revealContent(contentReference(v)!,v.id)},
    { priority: 5, match: isRegion, tab: 'image.viewer', params: (v) => ({ id: String(v.blocks.anchor.data.target), focus: v.id }) },
    { priority: 5, match: (v) => !!v.blocks.anchor && isSegment(v), tab: 'video.player', params: (v) => ({ id: String(v.blocks.anchor.data.target), focus: v.id }) },
    { priority: 5, match: isTextRange, tab: 'text.reader', params: (v) => ({ id: String(v.blocks.anchor.data.target), focus: v.id }) },
    { priority: 5, match: isPdfQuote, tab: 'pdf.viewer', params: (v) => ({ id: String(v.blocks.anchor.data.target), page: Number(v.blocks.anchor.data.page), focus: v.id, list: undefined, request: Date.now() }) }
  ],
  // 拖到其他软件时交出裁好的局部。片段只有一帧，导出片段以后走"导出"操作
  dragOut: [{ priority: 20, get: (v, host) => (isRegion(v) && v.blocks.still ? host.abs(String(v.blocks.still.data.path)) : undefined) }],
  views: [{ id: 'annotations', title: '批注', query: { has: ['anchor'] }, defaultVisible: false, order: 25 }]
}

export { annotateUi as plugin }
