// 全文搜索在界面上的部分（设计文档 11.8）：卡片上显示命中的那一句，文字里标出搜到的词。
// 集合标签页把当前的范围与搜索词放进 SearchContext，卡片自己去取摘要；同一时刻的请求攒成一批。

import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react'
import type { BlockKind, EntityView } from '../../shared/blocks'
import type { Snippet, TextSearch } from '../../shared/query'
import { marksIn } from '../../shared/search'
import type { UiHost } from './contracts'
import { useKinds } from './data'

/** 当前标签页的搜索条件（视图自带的加上临时输入的）；没有搜索时为空。 */
export const SearchContext = createContext<TextSearch[]>([])

export const useSearch = () => useContext(SearchContext)
export const useSearchText = () => useSearch().map((s) => s.text).join(' ') || undefined

/** 摘要缓存：范围、词、身份和数据定义均参与失效；旧请求不能覆盖较新的数据。 */
interface Entry { view: EntityView; kinds: BlockKind[]; snippet: Snippet | null }
const cache = new Map<string, Entry>()
const waiting = new Map<string, { ids: Map<string, Entry>; done: Set<() => void> }>()
const keyOf = (query: string, id: string) => `${query}\u0000${id}`

function request(host: UiHost, searches: TextSearch[], query: string, id: string, entry: Entry, done: () => void): void {
  let batch = waiting.get(query)
  if (!batch) {
    batch = { ids: new Map(), done: new Set() }
    waiting.set(query, batch)
    // 同一轮渲染里所有卡片的请求攒成一批
    setTimeout(() => {
      const b = waiting.get(query)!
      waiting.delete(query)
      host.core
        .snippets([...b.ids.keys()], searches)
        .then((found) => {
          for (const [x, requested] of b.ids) {
            if (cache.get(keyOf(query, x)) === requested) requested.snippet = found[x] ?? null
          }
          b.done.forEach((fn) => fn())
        })
        .catch((e) => console.error(e))
    }, 0)
  }
  batch.ids.set(id, entry)
  batch.done.add(done)
}

/** 这张卡片在当前搜索下命中的那一句。 */
export function useSnippet(host: UiHost, view: EntityView | undefined, searches: TextSearch[]): Snippet | undefined {
  const [, bump] = useState(0)
  const kinds = useKinds()
  // 取回来时卡片可能已经因为别的原因重绘过了：只要还在，就再画一次
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const query = JSON.stringify(searches)
  const key = view && searches.length ? keyOf(query, view.id) : undefined
  const entry = key ? cache.get(key) : undefined
  const stale = !!key && (entry?.view !== view || entry?.kinds !== kinds)
  useEffect(() => {
    if (!key || !view || !stale) return
    if (cache.size > 2000) cache.clear()
    const next = { view, kinds, snippet: null }
    cache.set(key, next)
    request(host, searches, query, view.id, next, () => mounted.current && bump((n) => n + 1))
  }, [key, view, searches, query, kinds, stale, host])
  return entry && !stale ? (entry.snippet ?? undefined) : undefined
}

/** 一段文字，标出其中的几处（[开始, 结束)）。 */
export function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: React.ReactNode[] = []
  let at = 0
  marks.forEach(([s, e], i) => {
    if (s > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, s)}</Fragment>)
    parts.push(<mark key={`m${i}`}>{text.slice(s, e)}</mark>)
    at = e
  })
  if (at < text.length) parts.push(<Fragment key="end">{text.slice(at)}</Fragment>)
  return <>{parts}</>
}

/** 在一段已经画好的页面里标出这些词（只在一个文字节点之内找，跨过加粗、链接的不算）。文字标签页、PDF 的文字层用。 */
export function markTermsIn(root: HTMLElement, terms: string[]): void {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  for (const node of nodes) {
    const marks = marksIn(node.data, terms)
    if (!marks.length) continue
    const frag = doc.createDocumentFragment()
    let at = 0
    for (const [s, e] of marks) {
      if (s > at) frag.append(node.data.slice(at, s))
      const m = doc.createElement('mark')
      m.textContent = node.data.slice(s, e)
      frag.append(m)
      at = e
    }
    if (at < node.data.length) frag.append(node.data.slice(at))
    node.replaceWith(frag)
  }
}
