import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
import { useEffect, useRef } from 'react'
import { textLocation } from './selection'
// 文字插件的界面：卡片（短的是一句引文，长的按 Markdown 排版）、空格预览、检查器、
// 文字标签页（双击打开）、⌘N 新建一段空白文字。摘录和文档（.md、.txt 文件）一视同仁。

import type { PreviewProps, UiPlugin, ViewProps } from '../../plugin-api/ui/contracts'
import { DraftStatus, useTextSession } from './session'
import { Backlinks, LinkList } from './links'
import { countWords, docOf, DocView, firstLine, opening } from './markdown'
import { readerTabType } from './reader'

/** 一句话的摘录（可以带一行出处）：不排版，当引文显示。 */
const isQuote = (s: string) => s.length <= 100 && s.split('\n').length <= 2 && !/[#*_`[\]>|$\\]/.test(s)

function TextCover({ view }: ViewProps) {
  useUiLocale()
  const doc = docOf(view)
  const s = doc?.content.trim() ?? ''
  if (!doc) return <div className="cover-pending" />
  if (!s) return <div className="cover-text cover-empty">{uiText("空白")}</div>
  if (doc.format === 'markdown' && isQuote(s)) return <div className="cover-text cover-quote">{s}</div>
  return <DocView doc={{ ...doc, content: opening(s) }} className="cover-text cover-md" />
}

function TextPreview({ view, host }: PreviewProps) {
  const doc = docOf(view)
  if (!doc) return null
  return (
    <div className="preview-doc" onMouseDown={(e) => e.stopPropagation()}>
      <DocView doc={doc} host={host} />
    </div>
  )
}

/** 摘录：检查器里可以直接改；长一点的去文字标签页。 */
function TextSection({ view, host }: ViewProps) {
  useUiLocale()
  const { session, snapshot } = useTextSession(view, host)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (input.current && session) return host.editing.bindInput(input.current, session, { syncChanges: true }) }, [host.editing, session])
  if (!session || !snapshot) return null
  return (
    <>
      <div className="text-section-editor">
      <textarea className="autosave" aria-label={uiText("文字正文")} ref={input} value={snapshot.text} rows={8} onChange={e => session.change(e.target.value)}
        onBlur={() => { void session.save().catch(() => {}) }}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.nativeEvent.isComposing) {
          e.preventDefault(); e.stopPropagation(); if (e.shiftKey) session.redo(); else session.undo()
        } }} />
      <DraftStatus session={session} />
      </div>
      <div className="text-actions">
        <button className="small" onClick={() => host.open(view.id)}>{uiText("在文字标签页中打开")}{' '}</button>
      </div>
    </>
  )
}

/** 文档：读出来的正文的情况。 */
function BodySection({ view, host }: ViewProps) {
  useUiLocale()
  const b = view.blocks.body.data
  return (
    <dl className="props">
      <dt>{uiText("格式")}</dt>
      <dd>{b.format === 'plain' ? uiText("纯文本") : 'Markdown'}</dd>
      <dt>{uiText("编码")}</dt>
      <dd>{String(b.encoding ?? '')}</dd>
      <dt>{uiText("字数")}</dt>
      <dd>{countWords(String(b.content ?? '')).toLocaleString()}</dd>
      <dt />
      <dd>
        <button className="small" onClick={() => host.open(view.id)}>{uiText("在文字标签页中打开")}{' '}</button>
      </dd>
    </dl>
  )
}

const isDoc = (v: Parameters<typeof docOf>[0]) => !!v.blocks.text || (!!v.blocks.body && !!v.blocks.file)

/** 被嵌进另一篇文字时：开头一段（不再展开里面的链接和嵌入，免得互相嵌套）。 */
function TextEmbed({ view, host }: ViewProps) {
  useUiLocale()
  const doc = docOf(view)
  if (!doc) return null
  return (
    <span className="embed-text" title={uiText("打开")} onClick={() => host.open(view.id)}>
      <DocView doc={{ ...doc, content: opening(doc.content, 600) }} className="embed-doc" />
    </span>
  )
}

/** 这篇文字提到的。 */
function LinksSection({ view, host }: ViewProps) {
  return <LinkList ids={(view.blocks.links.data.targets as string[] | undefined) ?? []} host={host} />
}

/** 提到它的：任何素材都可能被提到；一个也没有时分区不显示。 */
function BacklinksSection({ view, host }: ViewProps) {
  return <Backlinks id={view.id} host={host} />
}

export const textUi: UiPlugin = {
  id: 'text',
  contentLocations: [textLocation],
  views: [
    { id: 'texts', get title() { return uiText("文字") }, query: { has: ['text'] }, defaultVisible: false, order: 30 },
    { id: 'docs', get title() { return uiText("文档") }, query: { has: ['body'] }, defaultVisible: false, order: 31 }
  ],
  // 文档读出正文前是文件封面，读出后和摘录一样
  covers: [{ priority: 10, match: isDoc, Component: TextCover }],
  // 摘录的标题是第一行；文档用文件名（文件插件给的）
  titles: [{ priority: 50, get: (v) => (v.blocks.text ? firstLine(String(v.blocks.text.data.content ?? '')) : undefined) }],
  previews: [{ priority: 10, match: isDoc, Component: TextPreview }],
  embeds: [{ priority: 20, match: isDoc, Component: TextEmbed }],
  opens: [{ id: 'text.reader', get title() { return uiText("文字阅读器") }, priority: 20, match: isDoc, tab: 'text.reader', params: (v, from) => ({ id: v.id, list: from }) }],
  tabTypes: [readerTabType],
  creates: [{ id: 'text', get title() { return uiText("文字") }, order: 10, blocks: () => ({ text: { content: '' } }), open: (id) => ({ tab: 'text.reader', params: { id, edit: true } }) }],
  sections: [
    { id: 'text', get title() { return uiText("文本") }, order: 10, kinds: ['text'], Component: TextSection },
    { id: 'body', get title() { return uiText("文档") }, order: 15, kinds: ['body'], Component: BodySection },
    { id: 'links', get title() { return uiText("提到的") }, order: 26, kinds: ['links'], Component: LinksSection },
    { id: 'backlinks', get title() { return uiText("提到它的") }, order: 27, kinds: [], match: () => true, Component: BacklinksSection }
  ]
}

export { textUi as plugin }
