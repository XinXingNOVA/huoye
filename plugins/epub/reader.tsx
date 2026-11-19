import { EpubSelection } from './selection'
import type { ContentLocator } from '@resource-manager/plugin-api/content-selection'
import { createElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import type { Query } from '@resource-manager/plugin-api/query'
import { searchTextFor } from '@resource-manager/plugin-api/query'
import type { TabProps, UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { useEntityState } from '@resource-manager/plugin-api/ui/data'
import { useKeys } from '@resource-manager/plugin-api/ui/hooks'
import { bookOf, bookmarksOf, positionOf, progressOf, readingTags, type Book, type ChapterDocument, type Position, type ReaderNode } from './model'
import { useReaderSession } from './runtime'

export interface ReaderParams extends Record<string, unknown> { id: string; list?: Query; chapter?: number; offset?: number; request?: number; focus?: string; location?: ContentLocator }
export interface ReaderState { position?: Position; fontSize?: number; lineHeight?: number; theme?: 'system' | 'paper'; requestKey?: string }
interface Target { chapter: number; offset: number; anchor?: string; key: number }
const tags = new Set<string>(readingTags)
const bounded = (n: number | undefined, min: number, max: number, fallback: number) => Number.isFinite(n) ? Math.max(min, Math.min(max, n!)) : fallback

export function Reader(props: TabProps<ReaderParams, ReaderState>) {
  const state = useEntityState(props.params.id)
  if (!state.view) return <div className="epub-empty">{state.status === 'error' ? state.error : state.status === 'missing' ? '这本书已不存在' : '正在读取书籍…'}</div>
  const view = state.view, book = bookOf(view.blocks.epub?.data)
  if (view.deletedAt) return <div className="epub-empty">这本书已在回收站<button className="epub-button" onClick={() => void props.host.core.restore([view.id]).catch(e => props.host.notify(String(e)))}>恢复书籍</button></div>
  if (!book || book.sourceHash !== view.blocks.file?.data.hash) return <div className="epub-empty"><strong>{view.failures['epub.read'] ? '暂时无法阅读这本书' : '正在整理书籍…'}</strong><p>{view.failures['epub.read'] ?? '首次打开需要提取目录、正文和图片。'}</p><button className="epub-button" onClick={() => props.host.openData(view.id)}>查看原文件信息</button></div>
  return <BookReader key={`${view.id}:${book.sourceHash}`} {...props} view={view} book={book}/>
}

function BookReader({ params, host, active, saved, setState, setFocus, registerKeys, expose, view, book, id: tabId }: TabProps<ReaderParams, ReaderState> & { view: EntityView; book: Book }) {
  const { setCurrent } = useReaderSession()
  const [contentRoot, setContentRoot] = useState<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState(params.focus)
  useEffect(()=>setSelected(params.focus),[params.focus,params.request])
  useEffect(()=>{if(active)setFocus([selected??view.id])},[active,selected,view.id,setFocus])
  const initialSearch = searchTextFor(params.list, 'epubtext', 'content')?.trim() ?? ''
  const requestKey = `${params.request ?? ''}|${params.chapter ?? ''}|${params.offset ?? ''}|${initialSearch}`
  const [revealRequest, setRevealRequest] = useState(saved?.requestKey === requestKey ? undefined : params.focus)
  const appliedRequest = useRef(saved?.requestKey)
  const initial = useRef(positionOf(book, saved?.position ?? view.blocks.epubreading?.data)).current
  const [target, setTarget] = useState<Target>(() => ({ chapter: Math.max(0, book.chapters.findIndex(c => c.href === initial.chapter)), offset: initial.offset, key: 0 }))
  const [fontSize, setFontSize] = useState(() => bounded(saved?.fontSize, 14, 30, 19))
  const [lineHeight, setLineHeight] = useState(() => bounded(saved?.lineHeight, 1.5, 2.3, 1.9))
  const [theme, setTheme] = useState<'system' | 'paper'>(saved?.theme === 'paper' ? 'paper' : 'system')
  const [options, setOptions] = useState(false), [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false)
  const [loaded, setLoaded] = useState<{ path: string; document?: ChapterDocument; error?: string } | null>(null)
  const [retry, setRetry] = useState(0), [percent, setPercent] = useState(() => Math.floor(progressOf(book, initial) * 100))
  const scroll = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null), position = useRef(initial), ready = useRef(false)
  const navigation = useRef<{ key: number; anchor?: string } | null>(null), navigationKey = useRef(0)
  const pending = useRef<Position | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef({ host, setState, book, fontSize, lineHeight, theme }); latest.current = { host, setState, book, fontSize, lineHeight, theme }
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const next = pending.current; if (!next) return
    pending.current = undefined
    void latest.current.host.core.run('epub', 'savePosition', { id: view.id, ...next }).catch(e => latest.current.host.notify(`续读位置保存失败：${String(e)}`))
  }, [view.id])
  const report = useCallback((next: Position) => {
    position.current = next
    const current = latest.current
    current.setState({ position: next, fontSize: current.fontSize, lineHeight: current.lineHeight, theme: current.theme, requestKey: appliedRequest.current })
    setPercent(Math.floor(progressOf(current.book, next) * 100))
    pending.current = next
    clearTimeout(timer.current); timer.current = setTimeout(flush, 700)
  }, [flush])
  const go = useCallback((chapter: number, offset = 0, anchor?: string) => {
    const b = latest.current.book, c = b.chapters[chapter]; if (!c) return
    flush(); ready.current = false
    position.current = { sourceHash: b.sourceHash, chapter: c.href, offset: Math.max(0, Math.min(c.length, offset)) }
    const key = ++navigationKey.current; navigation.current = { key, anchor }
    setTarget({ chapter, offset: position.current.offset, key })
    setPercent(Math.floor(progressOf(b, position.current) * 100))
  }, [flush])
  const chapter = book.chapters[target.chapter], doc = loaded?.path === chapter.path ? loaded.document : undefined
  const loadError = loaded?.path === chapter.path ? loaded.error : undefined
  useEffect(() => {
    const controller = new AbortController(); ready.current = false
    fetch(host.url(chapter.path), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('章节缓存无法读取')
      const result = await response.json() as ChapterDocument
      if (result.version !== 1 || result.sourceHash !== book.sourceHash || result.href !== chapter.href || !Array.isArray(result.nodes) || typeof result.text !== 'string') throw new Error('章节缓存已失效')
      if (!controller.signal.aborted) setLoaded({ path: chapter.path, document: result })
    }).catch(error => { if (!controller.signal.aborted) setLoaded({ path: chapter.path, error: String(error) }) })
    return () => controller.abort()
  }, [chapter.path, chapter.href, book.sourceHash, host, retry])
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => { window.removeEventListener('beforeunload', flush); flush() }
  }, [flush])
  useEffect(() => { if (!active) flush() }, [active, flush])
  useEffect(() => {
    setState({ position: position.current, fontSize, lineHeight, theme, requestKey: appliedRequest.current })
  }, [fontSize, lineHeight, theme, setState])

  // 每次定位等当前章图片解码后再恢复。隐藏标签页不写零位置，异步旧章不能覆盖新章。
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el || !doc || !active) return
    let cancelled = false; ready.current = false
    const desired = position.current.offset
    const requested = navigation.current?.key === target.key ? navigation.current : null
    void Promise.all(Array.from(el.querySelectorAll('img')).map(img => img.decode().catch(() => {}))).then(() => {
      if (cancelled) return
      const anchor = requested?.anchor ? Array.from(el.querySelectorAll<HTMLElement>('[data-epub-anchor]')).find(node => node.dataset.epubAnchor === requested.anchor) : undefined
      if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - 26
      else revealOffset(el, desired)
      requestAnimationFrame(() => {
        if (cancelled) return
        ready.current = true
        // 仅实际的导航保存新位置；初次恢复保留原始记录，失败不会误记书首。
        if (requested) { navigation.current = null; report({ sourceHash: book.sourceHash, chapter: chapter.href, offset: currentOffset(el, doc.text.length) }) }
      })
    })
    return () => { cancelled = true; ready.current = false }
  }, [doc, target.key, target.anchor, target.offset, fontSize, lineHeight, active, book.sourceHash, chapter.href, report])
  useEffect(() => {
    const el = scroll.current; if (!el) return
    const observer = new ResizeObserver(() => { if (ready.current && active) revealOffset(el, position.current.offset) })
    observer.observe(el); return () => observer.disconnect()
  }, [active])
  const marks = useMemo(() => bookmarksOf(view.blocks.epubbookmarks?.data.items), [view.blocks.epubbookmarks?.data.items])
  useEffect(() => {
    if (!active) return
    setCurrent({ token: tabId, id: view.id, book, chapter: target.chapter, bookmarks: marks, go })
    return () => setCurrent(prev => prev?.token === tabId ? null : prev)
  }, [active, tabId, view.id, book, target.chapter, marks, go, setCurrent])
  useEffect(() => {
    if (appliedRequest.current === requestKey) return
    appliedRequest.current = requestKey
    setRevealRequest(params.focus)
    if (params.location?.provider === 'epub.quote' && params.location.version === 1 && params.location.data.sourceHash === book.sourceHash) {
      const chapter=book.chapters.findIndex(c=>c.href===params.location!.data.chapter)
      if(chapter>=0)go(chapter,Number(params.location.data.from)||0)
    } else if (params.chapter !== undefined) go(params.chapter - 1, params.offset)
    else if (initialSearch) {
      const content = String(view.blocks.epubtext?.data.content ?? ''), term = initialSearch.split(/\s+/)[0], at = content.toLowerCase().indexOf(term.toLowerCase())
      setQuery(term); setSearchOpen(true)
      if (at >= 0) { const c = chapterAt(book, at); go(c, at - book.chapters[c].start) }
    }
    // 请求键明确区分打开请求；阅读位置或书签更新不重复跳到搜索命中。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, go])
  const find = useCallback(() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()) }, [])
  useEffect(() => { expose({ find, exportable: () => ({ ids: [view.id], name: book.title }) }); return () => expose(null) }, [expose, find, view.id, book.title])
  useKeys(registerKeys, e => {
    if (!active || e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]')) return false
    if (e.key === 'ArrowRight') { go(target.chapter + 1); return true }
    if (e.key === 'ArrowLeft') { go(target.chapter - 1); return true }
    if (e.key === 'Escape' && (options || searchOpen)) { setOptions(false); setSearchOpen(false); return true }
    return false
  })
  const [submitted, setSubmitted] = useState('')
  const content = String(view.blocks.epubtext?.data.content ?? '')
  const matches = useMemo(() => {
    if (!submitted) return []
    const lower = content.toLowerCase(), term = submitted.toLowerCase(), out: number[] = []
    for (let from = 0; out.length < 200;) { const i = lower.indexOf(term, from); if (i < 0) break; out.push(i); from = i + term.length }
    return out
  }, [content, submitted])
  const [hit, setHit] = useState(0)
  const jumpHit = (at: number) => { if (!matches.length) return; const n = (at + matches.length) % matches.length; setHit(n); const c = chapterAt(book, matches[n]); go(c, matches[n] - book.chapters[c].start) }
  const submit = () => {
    const term = query.trim(); setSubmitted(term); setHit(0)
    if (!term) return
    const at = content.toLowerCase().indexOf(term.toLowerCase())
    if (at >= 0) { const c = chapterAt(book, at); go(c, at - book.chapters[c].start) }
  }
  const changeFont = (delta: number) => { setTarget(p => ({ ...p, offset: position.current.offset, anchor: undefined })); setFontSize(n => bounded(n + delta, 14, 30, 19)) }
  const addBookmark = () => {
    const p = { ...position.current, offset: scroll.current && doc && ready.current ? currentOffset(scroll.current, doc.text.length) : position.current.offset }
    void host.core.run('epub', 'addBookmark', { id: view.id, ...p, title: doc?.text.slice(p.offset, p.offset + 40).trim() || chapter.title })
      .then(() => host.notify('书签已保存，可撤销')).catch(e => host.notify(String(e)))
  }
  const panelTitle = `${target.chapter + 1} / ${book.chapters.length} 章`
  return <div className={`epub-reader epub-theme-${theme}`} style={{ '--epub-font-size': `${fontSize}px`, '--epub-line-height': lineHeight } as CSSProperties}>
    <header className="epub-toolbar">
      <button className="epub-button" title="打开书籍目录" onClick={() => host.showView('epub.contents')}>☰ <span>目录</span></button>
      <div className="epub-heading"><strong title={book.title}>{book.title}</strong><span title={chapter.title}>{chapter.title}</span></div>
      <button className="epub-button" aria-label="搜索书内正文" aria-pressed={searchOpen} onClick={() => searchOpen ? setSearchOpen(false) : find()}>搜索</button>
      <button className="epub-button" disabled={!doc || !!loadError} onClick={addBookmark}>书签＋</button>
      <div className="epub-settings-wrap"><button className="epub-button" aria-expanded={options} onClick={() => setOptions(v => !v)}>Aa <span>排版</span></button>
        {options ? <div className="epub-options"><strong>阅读排版</strong><div><span>字号</span><button aria-label="缩小字号" disabled={fontSize <= 14} onClick={() => changeFont(-1)}>−</button><output>{fontSize}</output><button aria-label="增大字号" disabled={fontSize >= 30} onClick={() => changeFont(1)}>＋</button></div>
          <label>行距<select value={lineHeight} onChange={e => { setTarget(p => ({ ...p, offset: position.current.offset, anchor: undefined })); setLineHeight(Number(e.target.value)) }}><option value={1.5}>紧凑</option><option value={1.9}>舒适</option><option value={2.3}>宽松</option></select></label>
          <label>背景<select value={theme} onChange={e => setTheme(e.target.value as 'system' | 'paper')}><option value="system">跟随应用</option><option value="paper">暖纸色</option></select></label>
          <small>使用统一阅读排版，保留正文结构与插图。</small></div> : null}
      </div>
    </header>
    {searchOpen ? <form className="epub-search" onSubmit={e => { e.preventDefault(); submit() }}><input ref={searchInput} aria-label="搜索书内正文" placeholder="搜索这本书的正文" value={query} onChange={e => setQuery(e.target.value)}/><button className="epub-button" type="submit">查找</button>
      <span aria-live="polite">{submitted ? matches.length ? `${hit + 1} / ${matches.length}${matches.length === 200 ? '+' : ''}` : '没有找到' : ''}</span><button className="epub-icon-button" type="button" aria-label="上一处命中" disabled={!matches.length} onClick={() => jumpHit(hit - 1)}>↑</button><button className="epub-icon-button" type="button" aria-label="下一处命中" disabled={!matches.length} onClick={() => jumpHit(hit + 1)}>↓</button></form> : null}
    {book.warnings.length ? <details className="epub-warning"><summary>阅读提示 · {book.warnings.length}</summary>{book.warnings.map(w => <p key={w}>{w}</p>)}</details> : null}
    {view.blocks.epubreading && view.blocks.epubreading.data.sourceHash !== book.sourceHash ? <div className="epub-warning">原文件已变化，旧阅读记录和书签保留；本次从书首开始。</div> : null}
    <div className="epub-scroll" ref={scroll} tabIndex={0} aria-label="电子书正文" onScroll={() => {
      if (!ready.current || !active || !doc || !scroll.current) return
      const next = { sourceHash: book.sourceHash, chapter: chapter.href, offset: currentOffset(scroll.current, doc.text.length) }
      if (next.chapter !== position.current.chapter || next.offset !== position.current.offset) report(next)
    }}>
      {loadError ? <div className="epub-empty"><strong>章节未能加载</strong><p>{loadError}</p><button className="epub-button" onClick={() => setRetry(v => v + 1)}>重试</button></div> : doc ? <article className="epub-page"><div className="epub-chapter-kicker">{panelTitle}</div><div ref={setContentRoot}><ChapterContent document={doc} host={host} go={go} term={submitted || (query ? initialSearch.split(/\s+/)[0] : '')}/></div><div className="epub-chapter-end"><span>本章完</span>{target.chapter + 1 < book.chapters.length ? <button className="epub-button" onClick={() => go(target.chapter + 1)}>继续下一章 →</button> : <span>已到全书末尾</span>}</div></article> : <div className="epub-empty">正在载入章节…</div>}
    </div>
    {doc && contentRoot && scroll.current && <EpubSelection host={host} tabId={tabId} active={active} source={view} root={scroll.current} content={contentRoot} document={doc} book={book} go={go} version={`${submitted}:${fontSize}:${lineHeight}`} selected={selected} select={setSelected} revealId={revealRequest} revealKey={`${params.focus}:${params.request}`} onReveal={() => setRevealRequest(undefined)}/>}
    <footer className="epub-footer"><button className="epub-button" disabled={!target.chapter} onClick={() => go(target.chapter - 1)}>← 上一章</button><span>{panelTitle}<span className="epub-dot">·</span>全书 {percent}%</span><button className="epub-button" disabled={target.chapter + 1 >= book.chapters.length} onClick={() => go(target.chapter + 1)}>下一章 →</button></footer>
  </div>
}

function chapterAt(book: Book, offset: number) {
  let index = 0
  for (let i = 0; i < book.chapters.length; i++) { if (book.chapters[i].start <= offset) index = i; else break }
  return index
}
function currentOffset(el: HTMLElement, length: number): number {
  if (el.scrollHeight > el.clientHeight + 40 && el.scrollTop >= el.scrollHeight - el.clientHeight - 4) return length
  const top = el.getBoundingClientRect().top + 28
  let last = 0
  for (const span of el.querySelectorAll<HTMLElement>('[data-epub-offset]')) {
    const rect = span.getBoundingClientRect(); last = Number(span.dataset.epubOffset)
    if (rect.bottom > top) return Math.min(length, last)
  }
  return Math.min(length, last)
}
function revealOffset(el: HTMLElement, offset: number) {
  if (offset === 0) { el.scrollTop = 0; return }
  let target: HTMLElement | undefined
  for (const node of el.querySelectorAll<HTMLElement>('[data-epub-offset]')) { if (Number(node.dataset.epubOffset) <= offset) target = node; else break }
  if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 28
}
const ChapterContent = memo(function ChapterContent({ document, host, go, term }: { document: ChapterDocument; host: UiHost; go(chapter: number, offset?: number, anchor?: string): void; term: string }) {
  const render = (node: ReaderNode, key: number): ReactNode => {
    if ('text' in node) {
      const pieces: ReactNode[] = []
      for (let i = 0; i < node.text.length; i += 120) {
        const text = node.text.slice(i, i + 120), at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1
        pieces.push(<span data-epub-offset={node.start + i} key={i}>{at >= 0 ? <>{text.slice(0, at)}<mark>{text.slice(at, at + term.length)}</mark>{text.slice(at + term.length)}</> : text}</span>)
      }
      return <span key={key}>{pieces}</span>
    }
    if (!tags.has(node.tag)) return null
    const props: Record<string, unknown> = { key, ...(node.anchor ? { 'data-epub-anchor': node.anchor } : {}) }
    if (node.tag === 'img') return node.image ? <img key={key} src={host.url(node.image)} alt={node.alt ?? ''} draggable={false} data-epub-anchor={node.anchor}/> : null
    if (node.tag === 'a' && node.link) {
      props.href = '#'; props.onClick = (e: { preventDefault(): void }) => { e.preventDefault(); const link = node.link!; if ('external' in link) host.openExternal(link.external); else go(link.chapter, 0, link.anchor) }
    }
    if (node.colspan) props.colSpan = node.colspan
    if (node.rowspan) props.rowSpan = node.rowspan
    return createElement(node.tag, props, ...node.children.map(render))
  }
  return <div className="epub-content">{document.nodes.map(render)}</div>
})
