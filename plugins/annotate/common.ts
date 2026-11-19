// 批注插件的界面里共用的：一个素材上的局部、写下的一句话怎么变成笔记和标签、文本区间怎么找回原文。

import { useEffect, useState } from 'react'
import type { EntityView } from '@resource-manager/plugin-api/blocks'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { parseAnnotation } from './parse'

export const firstLine = (text: unknown, max = 28) => {
  const line = String(text ?? '').split('\n')[0].trim()
  return line.length > max ? line.slice(0, max) + '…' : line
}

/** 局部的标签：笔记的第一行，没写字时用标签。 */
export const labelOf = (v: EntityView | undefined, max = 28) =>
  firstLine(v?.blocks.note?.data.text, max) || ((v?.blocks.tags?.data.values as string[] | undefined) ?? []).map((t) => `#${t}`).join(' ')

/** 写下的一句话 → 笔记块、标签块。标签插件没有启用时，#词 就留在笔记里。 */
export function annotationBlocks(host: UiHost, text: string): Record<string, Record<string, unknown>> {
  const { note, tags } = parseAnnotation(text)
  const tagsOn = host.kind('tags') && !host.kind('tags')?.dormant
  if (tags.length && !tagsOn) return { note: { text: text.trim() } }
  return { ...(note ? { note: { text: note } } : {}), ...(tags.length ? { tags: { values: tags } } : {}) }
}

/** 这个素材上的局部（依附它的身份）。 */
export function useLocals(host: UiHost, target: string): string[] {
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () =>
      host.core
        .query({ where: [{ op: 'eq', kind: 'anchor', field: 'target', value: target }], dir: 'asc' })
        .then((r) => alive && setIds(r.ids))
    run()
    const off = host.core.on('listChanged', () => {
      clearTimeout(timer)
      timer = setTimeout(run, 120)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [host, target])
  return ids
}


export const isTextRange = (v: EntityView) => v.blocks.anchor?.data.type === '文本区间'
export const isPdfQuote = (v: EntityView) => v.blocks.anchor?.data.type === 'PDF摘录'
export const isContentQuote = (v: EntityView) => v.blocks.anchor?.data.type === '内容摘录'
export const isQuote = (v: EntityView) => isTextRange(v) || isPdfQuote(v) || isContentQuote(v)

/** 文本区间的锚点：原文片段、前后文、当时的位置。 */
export interface Quote {
  quote: string
  prefix: string
  suffix: string
  offset: number
}

export const quoteOf = (v: EntityView | undefined): Quote | undefined => {
  const a = v?.blocks.anchor?.data
  if ((a?.type !== '文本区间' && a?.type !== 'PDF摘录' && a?.type !== '内容摘录') || !a.quote) return undefined
  return { quote: String(a.quote), prefix: String(a.prefix ?? ''), suffix: String(a.suffix ?? ''), offset: Number(a.offset) || 0 }
}

/** 两段字从尾部（或头部）起有多少个字一样。 */
const sameTail = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}
const sameHead = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/**
 * 在现在的文字里找回这一句（W3C 标注的"引文选择器"）：原文片段出现在哪几处，挑前后文对得最多的；
 * 一样多时挑离当时位置最近的。找不到（原文改了）返回 undefined。
 */
export function locateQuote(text: string, q: Quote): { from: number; to: number } | undefined {
  let best: number | undefined
  let bestScore = -Infinity
  for (let i = text.indexOf(q.quote); i >= 0; i = text.indexOf(q.quote, i + 1)) {
    const context = sameTail(text.slice(Math.max(0, i - q.prefix.length), i), q.prefix) + sameHead(text.slice(i + q.quote.length), q.suffix)
    const score = context - Math.abs(i - q.offset) / (text.length + 1)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  return best === undefined ? undefined : { from: best, to: best + q.quote.length }
}
