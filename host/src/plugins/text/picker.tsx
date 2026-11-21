import { uiText, useUiLocale } from '../../shared/i18n/interface-display'
// 编辑器里的链接选择器（设计文档 11.9）：打 [[（或 ![[ 嵌入）弹出，接着打的字就是搜索词。
// 用全文搜索找（标题、正文、笔记、文件名、标签……），标题对得上的排前面；没打字时是最近收录的。
// 选中后插入 [[ID|标题]]：按身份链接，改名、重名都不影响；标题只是给人看的。

import { useEffect, useState } from 'react'
import type { EntityView } from '../../shared/blocks'
import type { UiHost } from '../../plugin-api/ui/contracts'

/** 光标前面正在写的 [[…：从哪里开始、搜什么、是不是嵌入。 */
export interface Trigger {
  start: number
  query: string
  embed: boolean
}

export function findTrigger(text: string, caret: number): Trigger | undefined {
  const m = /(!?)\[\[([^[\]|\n]*)$/.exec(text.slice(0, caret))
  return m ? { start: m.index, query: m[2], embed: m[1] === '!' } : undefined
}

const MAX = 8

/** 选择器里的候选：搜到的，标题以搜索词开头的最前，标题里有的其次，其余按收录时间。 */
export function usePickerItems(host: UiHost, query: string | undefined, self: string): EntityView[] {
  const [items, setItems] = useState<EntityView[]>([])
  useEffect(() => {
    if (query === undefined) return setItems([])
    let alive = true
    const timer = setTimeout(async () => {
      const q = query.trim()
      const r = await host.core.query(q ? { text: q } : {})
      const ids = r.ids.filter((x) => x !== self).slice(0, 40)
      const byId = new Map((await host.core.get(ids)).map((v) => [v.id, v]))
      if (!alive) return
      const lower = q.toLowerCase()
      const rank = (v: EntityView) => {
        const t = host.title(v).toLowerCase()
        return !lower ? 0 : t.startsWith(lower) ? 0 : t.includes(lower) ? 1 : 2
      }
      const views = ids.map((id) => byId.get(id)).filter((v): v is EntityView => !!v)
      setItems(
        views
          .map((v, i) => ({ v, i }))
          .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
          .slice(0, MAX)
          .map((x) => x.v)
      )
    }, 100)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [host, query, self])
  return items
}

export function LinkPicker({
  host,
  trigger,
  items,
  index,
  at,
  pick
}: {
  host: UiHost
  trigger: Trigger
  items: EntityView[]
  index: number
  at: { x: number; y: number }
  pick(v: EntityView): void
}) {
  useUiLocale()
  return (
    <div className="link-picker" style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.preventDefault()}>
      <div className="link-picker-head muted">
        {trigger.embed ? uiText("嵌入") : uiText("链接到")}
        {trigger.query ? `「${trigger.query}」` : uiText("：最近收录的")}
        <span className="link-picker-keys">{uiText("↑↓ 选择 · 回车插入 · Esc 关闭")}</span>
      </div>
      {items.length === 0 && <div className="link-picker-empty muted">{uiText("没有找到")}</div>}
      {items.map((v, i) => {
        const thumb = v.blocks.thumb
        return (
          <div key={v.id} className={`link-picker-item${i === index ? ' active' : ''}`} onClick={() => pick(v)}>
            <span className="link-picker-thumb">{thumb ? <img src={host.url(String(thumb.data.path), thumb.seq)} alt="" /> : <span className="link-row-icon">{uiText("文")}</span>}</span>
            <span className="link-picker-title">{host.title(v)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 文本框里某个位置的坐标（相对文本框左上角）：用一个样式相同的隐藏元素量出来。 */
const MIRRORED = [
  'box-sizing', 'width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-style', 'font-variant', 'font-weight',
  'font-stretch', 'font-size', 'line-height', 'font-family', 'text-align', 'text-transform', 'text-indent',
  'letter-spacing', 'word-spacing', 'tab-size'
]

export function caretXY(el: HTMLTextAreaElement, index: number): { x: number; y: number; h: number } {
  const document = el.ownerDocument
  const cs = document.defaultView!.getComputedStyle(el)
  const div = document.createElement('div')
  for (const p of MIRRORED) div.style.setProperty(p, cs.getPropertyValue(p))
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' })
  div.textContent = el.value.slice(0, index)
  const span = document.createElement('span')
  span.textContent = el.value.slice(index, index + 1) || '.'
  div.appendChild(span)
  document.body.appendChild(div)
  const out = { x: span.offsetLeft, y: span.offsetTop - el.scrollTop, h: parseFloat(cs.lineHeight) || 24 }
  div.remove()
  return out
}
