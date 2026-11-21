import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// Markdown 的显示：卡片、空格预览、文字标签页共用。
// 不认 HTML 标签（原样显示成文字），所以不需要再过滤脚本；网页上的图片不从网上加载，显示成链接。
// 双链（设计文档 11.9）：[[…]] 是链接，![[…]] 是嵌入。阅读时（给了 host）先排出空位，再把链接、嵌入的组件
// 放进去（嵌入的可能是一个播放器）；卡片上只显示它的字。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { EntityView } from '../../shared/blocks'
import { marksIn } from '../../shared/search'
import { isEntityId, stripWikiLinks, wikiLinkLabel } from '../../shared/wikilink'
import { Embed } from '../../plugin-api/ui/media'
import { Marked } from '../../plugin-api/ui/search'
import { useEntity, useGone } from '../../plugin-api/ui/data'
import type { UiHost } from '../../plugin-api/ui/contracts'
import { renderTextMarkdown } from './markdown-render'
import { markDocTerms } from './highlight'
import 'katex/dist/katex.css'
import './math.css'

/** 一篇文字：摘录（文本块，总是 Markdown）或文档（文件读出的正文，Markdown 或纯文本）。 */
export interface Doc {
  content: string
  format: 'markdown' | 'plain'
  /** 文档：内容在文件里。 */
  file: boolean
}

export function docOf(v: EntityView): Doc | undefined {
  if (v.blocks.text) return { content: String(v.blocks.text.data.content ?? ''), format: 'markdown', file: false }
  if (v.blocks.body && v.blocks.file) {
    return { content: String(v.blocks.body.data.content ?? ''), format: v.blocks.body.data.format === 'plain' ? 'plain' : 'markdown', file: true }
  }
  return undefined
}

/**
 * 显示一篇文字。host 给了时，点链接用系统浏览器打开；卡片上不给（点卡片是选中，不是打开链接）。
 * highlight：标出这些词（从搜索结果打开时）。
 */
export function DocView({ doc, host, className = '', highlight }: { doc: Doc; host?: UiHost; className?: string; highlight?: string[] }) {
  const live = !!host
  const html = useMemo(() => (doc.format === 'markdown' ? renderTextMarkdown(doc.content, live) : ''), [doc.content, doc.format, live])
  const ref = useRef<HTMLDivElement>(null)
  const terms = highlight?.join(' ') ?? ''
  useLayoutEffect(() => {
    if (ref.current && terms) markDocTerms(ref.current, terms.split(' '))
  }, [html, terms])
  // 排好版之后找出链接、嵌入的空位，把组件放进去
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    setSlots(live && ref.current ? [...ref.current.querySelectorAll<HTMLElement>('[data-ref]')] : [])
  }, [html, terms, live])
  if (doc.format === 'plain') {
    return (
      <div className={`doc-plain ${className}`}>
        {highlight?.length ? <Marked text={doc.content} marks={marksIn(doc.content, highlight)} /> : doc.content}
      </div>
    )
  }
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest('a')
    if (!a || !host) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:/i.test(href)) host.openExternal(href)
  }
  // 换了要标的词就换一个元素重新排版，免得在上一次标过的里面再标一遍
  return (
    <>
      <div key={terms} ref={ref} className={`md ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {host &&
        slots.map((el, i) =>
          createPortal(
            el.dataset.embed !== undefined ? (
              <EmbedSlot target={el.dataset.ref!} label={el.dataset.label} host={host} />
            ) : (
              <WikiLinkChip target={el.dataset.ref!} label={el.dataset.label} host={host} />
            ),
            el,
            String(i)
          )
        )}
    </>
  )
}

/**
 * 链接指的是谁：ID 直接用；文件名按文件块找（也试 名字.md）。
 * undefined：还在找；null：找不到。
 */
function useTarget(host: UiHost, target: string): string | null | undefined {
  const [found, setFound] = useState<string | null | undefined>(isEntityId(target) ? target : undefined)
  useEffect(() => {
    if (isEntityId(target)) return setFound(target)
    let alive = true
    const byName = (name: string) =>
      host.core.query({ scope: 'all', where: [{ op: 'eq', kind: 'file', field: 'name', value: name }] }).then((r) => r.ids[0])
    void byName(target)
      .then((id) => id ?? byName(`${target}.md`))
      .then((id) => alive && setFound(id ?? null))
    return () => {
      alive = false
    }
  }, [host, target])
  return found
}

/** 文字里的一个链接：显示写好的字，没写就用对方现在的标题；点一下打开它。 */
function WikiLinkChip({ target, label, host }: { target: string; label?: string; host: UiHost }) {
  useUiLocale()
  const id = useTarget(host, target)
  const view = useEntity(id ?? undefined)
  // 指向的身份被彻底删除了：链接留着（保留原值），显示为找不到
  const gone = useGone(id ?? undefined)
  const missing = id === null || gone
  const text = label || (view ? host.title(view) : wikiLinkLabel({ target }) || '…')
  const state = missing ? ' missing' : view?.deletedAt ? ' trashed' : ''
  return (
    <a
      className={`wikilink${state}`}
      title={missing ? uiText("找不到它") : view?.deletedAt ? uiText("在回收站里") : view ? uiText("打开「{value1}」", { value1: String(host.title(view)) }) : ''}
      onClick={(e) => {
        e.preventDefault()
        if (id && !missing) host.open(id)
      }}
    >
      {text}
    </a>
  )
}

/** 文字里的一个嵌入：交给宿主的嵌入（由认识它的插件画）。 */
function EmbedSlot({ target, label, host }: { target: string; label?: string; host: UiHost }) {
  useUiLocale()
  const id = useTarget(host, target)
  if (id === undefined) return <span className="embed embed-loading" />
  if (id === null) return <span className="embed embed-missing">{uiText("找不到「")}{label || target}」</span>
  return <Embed id={id} host={host} fallback={label} />
}

/** 第一行去掉 Markdown 记号，用作标题。 */
export function firstLine(content: string, max = 60): string | undefined {
  const line = stripWikiLinks(content)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  const s = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .trim()
  return s ? s.slice(0, max) : undefined
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/g

/** 字数：汉字一个算一个，西文按词。 */
export function countWords(text: string): number {
  const s = stripWikiLinks(text)
  return (s.match(CJK)?.length ?? 0) + (s.replace(CJK, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0)
}

/** 卡片上只显示开头一段：在这么多字以内的最后一个换行处截断，免得截在一个记号中间。 */
export function opening(content: string, max = 900): string {
  if (content.length <= max) return content
  const cut = content.lastIndexOf('\n', max)
  return content.slice(0, cut > max / 2 ? cut : max)
}
