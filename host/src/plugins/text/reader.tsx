import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// 文字标签页：文字插件提供的单素材标签页（设计文档 11.7）。
// 双击文字或文档打开；按 Markdown 排版阅读，E（或双击正文）切到编辑，Esc 回到阅读。
// 在打开它的列表里切上一篇 / 下一篇（摘录和文档之间都能切）。
// 摘录改的是库里的文本块；版本文档显式保存，历史内容通过文件版本恢复。
// 从搜索结果打开时（打开它的列表里有搜索词），标出这些词，跳到第一处。
// 双链（11.9）：编辑时打 [[ 选一个素材插入链接（![[ 嵌入），也可以把卡片拖进来；页脚列出提到这篇的文字。
// 阅读时开放文字叠加层（11.10）：坐标是排好版的文字里的字符位置，批注插件在上面划线、批注。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EntityView } from '../../shared/blocks'
import { searchTextFor, type Query } from '../../shared/query'
import { searchTerms } from '../../shared/search'
import { useEntity, useEntityState } from '../../plugin-api/ui/data'
import { useKeys, useUiEffect } from '../../plugin-api/ui/hooks'
import { useNeighbors } from '../../plugin-api/ui/navigation'
import type { TabProps, TabType, TextIndex, UiHost } from '../../plugin-api/ui/contracts'
import { Backlinks } from './links'
import { countWords, docOf, DocView, type Doc } from './markdown'
import { DraftStatus, openTextSession, textSessionKey, useTextSession } from './session'
import { Editor, type EditorPosition } from './editor'
import { FileEditor } from './file-editor'
import { TextSelection } from './selection'
import { buildTextIndex } from './textindex'

export interface ReaderParams extends Record<string, unknown> {
  id: string
  /** 打开它的列表：上一篇 / 下一篇在这里面找。 */
  list?: Query
  /** 打开就编辑（例如 ⌘N 新建的空白文字）。 */
  edit?: boolean
  /** 打开时定位到的身份（例如从摘句的卡片打开：滚到那一句并选中）。 */
  request?: number
  focus?: string
}


interface ReaderState { id: string; editing: boolean; scroll: number; cursor?: EditorPosition }
function Reader(props: TabProps<ReaderParams, ReaderState>) {
  useUiLocale()
  const state = useEntityState(props.params.id)
  const contextTitle = state.view ? props.host.title(state.view) : uiText("文字阅读页")
  useEffect(() => props.expose({ context: { title: contextTitle } }), [props.expose, contextTitle])
  const orphan = props.host.editing.get(textSessionKey(props.params.id))
  return state.view ? <ReaderContent key={state.view.id} {...props} view={state.view} /> : <Status>
    {state.status === 'missing' ? uiText("素材已不存在") : uiText("正在读取…")}
    {orphan && <DraftStatus session={orphan} unavailable={state.status === 'missing'} />}
  </Status>
}
function ReaderContent({ params, host, setFocus, setParams, registerKeys, active, id: tabId, saved, setState, view }: TabProps<ReaderParams, ReaderState> & { view: EntityView }) {
  useUiLocale()
  const { session, snapshot } = useTextSession(view, host)
  const resume = saved?.id === params.id ? saved : undefined
  const local = useRef<ReaderState>(resume ?? { id: params.id, editing: !!params.edit, scroll: 0 })
  const remember = (patch: Partial<ReaderState>) => { local.current = { ...local.current, ...patch }; setState(local.current) }
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = local.current.scroll }, [])
  const nav = useNeighbors(host, params.list, params.id, ['text', 'body'])
  const [editing, setEditing] = useState(resume?.editing ?? !!params.edit)
  useEffect(() => remember({ editing }), [editing])
  const [selected, setSelected] = useState(params.focus)

  useEffect(() => setSelected(params.focus), [params.focus, params.id, params.request])
  // 焦点：选中的摘句，或者这篇文字本身。检查器跟着显示
  useEffect(() => setFocus([selected ?? params.id]), [selected, params.id, setFocus])
  // 换了一篇：按参数决定是不是直接编辑
  const lastEdit = useRef(params.edit)
  useEffect(() => { if (lastEdit.current !== params.edit) setEditing(!!params.edit); lastEdit.current = params.edit }, [params.edit])

  const go = (id: string | undefined) => {
    if (id) setParams({ ...params, id, edit: undefined, focus: undefined })
  }
  const storedDoc = docOf(view)
  const doc = storedDoc && snapshot ? { ...storedDoc, content: snapshot.text } : storedDoc
  const editable = !!view && !!doc && canEdit(view, host)

  // 搜索词：标出来，跳到第一处；点标题栏上的"N 处"跳到下一处
  const contentKind = doc?.file ? 'body' : 'text'
  const terms = useMemo(() => searchTerms(searchTextFor(params.list, contentKind, 'content')), [params.list, contentKind])
  const page = useRef<HTMLDivElement>(null)
  const [hits, setHits] = useState(0)
  const cursor = useRef(0)
  const showHit = (i: number) => {
    const marks = page.current?.querySelectorAll('mark') ?? []
    if (!marks.length) return
    cursor.current = (i + marks.length) % marks.length
    marks.forEach((m, j) => m.classList.toggle('current', j === cursor.current))
    marks[cursor.current].scrollIntoView({ block: 'center' })
  }
  // 排版（子组件的布局副作用）里标好之后再数
  useEffect(() => {
    setHits(page.current?.querySelectorAll('mark').length ?? 0)
    showHit(0)
  }, [params.id, terms, doc?.content, editing])

  // 文字叠加层的坐标：排版、页面大小变了就重新量（链接、嵌入填进来，搜索词标出来，窗口改了大小）
  const docRoot = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<{ index: TextIndex; version: number }>()
  const hasText = !!doc?.content.trim()
  useUiEffect(display => {
    const root = docRoot.current
    const pageEl = page.current
    if (!root || !pageEl || editing || !hasText) return setLayout(undefined)
    let cancelFrame: (() => void) | undefined
    const rebuild = () => {
      cancelFrame?.()
      cancelFrame = display.frame(() => setLayout(l => ({ index: buildTextIndex(root), version: (l?.version ?? 0) + 1 })))
    }
    rebuild()
    display.observeMutations(root, rebuild, { childList: true, subtree: true, characterData: true })
    display.observeResize(pageEl, rebuild)
    // 字体加载后即使总高度没变，也更新选区坐标。
    display.document.fonts.addEventListener('loadingdone', rebuild)
    return () => display.document.fonts.removeEventListener('loadingdone', rebuild)
  }, [editing, hasText, view?.id])

  // 编辑时按键交给输入框；阅读时 ← → 切换，E / 回车开始编辑，Esc 取消选中
  useKeys(registerKeys, (e) => {
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return false
    if (e.key === 'Escape' && selected) {
      setSelected(undefined)
      return true
    }
    switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
      case 'ArrowLeft':
      case 'p':
        go(nav.prev)
        return true
      case 'ArrowRight':
      case 'n':
        go(nav.next)
        return true
      case 'e':
      case 'Enter':
        if (editable) setEditing(true)
        return true
    }
    return false
  })

  if (!view) return <Status>{uiText("正在读取…")}</Status>
  if (view.deletedAt) {
    return (
      <Status>
        {session && <DraftStatus session={session} unavailable />}{uiText("已移到回收站")}{' '}<button className="small" onClick={() => host.core.restore([view.id])}>{uiText("恢复")}{' '}</button>
      </Status>
    )
  }
  if (!doc) return <Status>{session && <DraftStatus session={session} unavailable />}{view.blocks.file ? uiText("正在读取文件…") : uiText("不是文字")}</Status>

  const save = () => { void session?.save().catch(() => {}) }

  return (
    <div className="reader">
      <div className="reader-bar">
        <button className="player-btn" title={uiText("上一篇（←）")} disabled={!nav.prev} onClick={() => go(nav.prev)}>
          ‹
        </button>
        <button className="player-btn" title={uiText("下一篇（→）")} disabled={!nav.next} onClick={() => go(nav.next)}>
          ›
        </button>
        <span className="player-title">
          {host.title(view)}
          {nav.total > 1 && nav.index >= 0 && (
            <span className="muted">
              {'  '}
              {nav.index + 1} / {nav.total}
            </span>
          )}
        </span>
        {terms.length > 0 && !editing && (
          <button className="small find-chip" title={uiText("跳到下一处")} disabled={!hits} onClick={() => showHit(cursor.current + 1)}>
            「{terms.join(' ')}」{hits ? uiText("{hits} 处", { hits }) : uiText("正文里没有")}
          </button>
        )}
        <Meta view={view} doc={doc} host={host} />
        {editable && (
          <button className={`small${editing ? ' primary' : ''}`} title={editing ? uiText("回到阅读（Esc）") : uiText("编辑（E）")} onClick={() => setEditing(!editing)}>
            {editing ? uiText("完成") : uiText("编辑")}
          </button>
        )}
      </div>
      {session && <DraftStatus session={session} />}
      <div className="reader-scroll" ref={scroll} onScroll={e => remember({ scroll: e.currentTarget.scrollTop })}>
        <div className="reader-page" data-hy-part="reader-page" role="article" aria-label={uiText("阅读正文")} ref={page}>
          {editing ? (
            doc.file ? <FileEditor key={view.id} view={view} host={host} initial={doc.content} done={() => setEditing(false)} note={encodingNote(view)} /> : <Editor key={view.id} session={session} position={local.current.cursor} onPosition={cursor => remember({ cursor })} self={view.id} host={host} initial={doc.content} save={save} done={() => setEditing(false)} />
          ) : doc.content.trim() ? (
            // 双击正文是选词（划线、批注要用），编辑用 E 或"编辑"按钮
            <div ref={docRoot}>
              <DocView doc={doc} host={host} className="reader-doc" highlight={terms} />
            </div>
          ) : (
            <div className="reader-empty" onDoubleClick={() => editable && setEditing(true)}>{uiText("空白。按 E 或者双击这里开始写")}{' '}</div>
          )}
          {!editing && (
            <div className="reader-backlinks">
              <Backlinks id={view.id} host={host} title={uiText("提到它的")} />
            </div>
          )}
          {!editing && !snapshot?.dirty && layout && docRoot.current && page.current && !host.overlays('text').some(o=>o.selection!=='shared') &&
            <TextSelection tabId={tabId} active={active} target={view} host={host} root={docRoot.current} page={page.current} index={layout.index} version={layout.version} selected={selected} select={setSelected} revealId={params.focus} revealKey={`${params.id}:${params.focus}:${params.request}`}/>}
          {!editing && !snapshot?.dirty && active &&
            layout &&
            docRoot.current &&
            page.current &&
            host.overlays('text').map((o) => (
              <o.Component
                key={o.id}
                target={view}
                host={host}
                root={docRoot.current!}
                page={page.current!}
                index={layout.index}
                version={layout.version}
                selected={selected}
                select={setSelected}
                revealId={params.focus}
              />
            ))}
        </div>
      </div>
    </div>
  )
}

/** 能不能改：提供这种数据的插件启用着（停用的插件留下的数据只读）。 */
function canEdit(view: EntityView, host: UiHost): boolean {
  const kind = view.blocks.text ? 'text' : 'file'
  const def = host.kind(kind)
  return !!def && !def.dormant
}

/** 不是 UTF-8 的文档，保存后会变成 UTF-8：编辑前说一声。 */
function encodingNote(view: EntityView): string | undefined {
  const enc = view.blocks.body?.data.encoding
  return enc && enc !== 'UTF-8' ? uiText("这个文件是 {value1} 编码，保存后会变成 UTF-8", { value1: String(String(enc)) }) : undefined
}

/** 标题栏右边：来源、字数、文档的格式和编码。 */
function Meta({ view, doc, host }: { view: EntityView; doc: Doc; host: UiHost }) {
  useUiLocale()
  const source = view.blocks.source?.data
  const parts = [
    doc.file ? (doc.format === 'markdown' ? uiText("Markdown 文档") : uiText("纯文本文档")) : '',
    doc.file ? String(view.blocks.body?.data.encoding ?? '') : '',
    uiText("{value1} 字", { value1: String(countWords(doc.content).toLocaleString()) })
  ].filter(Boolean)
  return (
    <span className="muted reader-meta">
      {source?.url ? (
        <button className="link" title={String(source.url)} onClick={() => host.openExternal(String(source.url))}>
          {String(source.site ?? source.url)}
        </button>
      ) : null}
      {parts.join(' · ')}
    </span>
  )
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="reader">
      <div className="reader-scroll">
        <div className="player-status">{children}</div>
      </div>
    </div>
  )
}

function ReaderTitle({ params, host }: { params: ReaderParams; host: UiHost }) {
  useUiLocale()
  const view = useEntity(params.id)
  return <>{view ? host.title(view) : uiText("文字")}</>
}

export const readerTabType: TabType<ReaderParams, ReaderState> = {
  instances: { scope: 'content' },
  async beforeLeave({ params, host, signal }) {
    signal.throwIfAborted()
    const session = host.editing.get(textSessionKey(params.id))
    if (!session?.snapshot().dirty && !session?.snapshot().conflict) return
    const view = (await host.core.get([params.id]))[0]
    signal.throwIfAborted()
    if (view?.blocks.text) {
      openTextSession(view, host)
      session.observe({ text: String(view.blocks.text.data.content ?? ''), revision: view.blocks.text.seq })
    }
    await session.save()
  },
  id: 'text.reader',
  Title: ReaderTitle,
  Component: Reader,
  // 普通打开复用；显式新建视图共享文字草稿。
  key: (params) => params.id
}
