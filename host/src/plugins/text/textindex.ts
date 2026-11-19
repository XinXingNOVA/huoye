// 文字叠加层的坐标系（设计文档 11.10）：排好版的文字里的字符位置。
// 链接、嵌入不算在里面（它们显示的字会变，见文字插件的失配检查）；搜索词的标记不影响（只是把字包了一层）。

import type { TextIndex } from '../../plugin-api/ui/contracts'

// KaTeX 同时包含无障碍 MathML 和可见字形，只索引可见部分；vlist-s 是排版用零宽字符。
const SKIP = '[data-ref], .embed, .wikilink, .katex-mathml, .katex .vlist-s'

export function buildTextIndex(root: HTMLElement): TextIndex {
  const nodes: { node: Text; start: number }[] = []
  let text = ''
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length })
    text += (n as Text).data
  }

  /** 第 pos 个字在哪个文字节点里（落在两个节点交界时取后一个，取结束位置时取前一个）。 */
  const at = (pos: number, end: boolean): { node: Text; offset: number } | undefined => {
    let lo = 0
    let hi = nodes.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (nodes[mid].start <= pos) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (found < 0) return undefined
    let i = found
    if (end) while (i > 0 && nodes[i].start === pos) i--
    const n = nodes[i]
    const offset = pos - n.start
    return offset <= n.node.data.length ? { node: n.node, offset } : undefined
  }

  return {
    text,
    range(from, to) {
      const s = at(from, false)
      const e = at(to, true)
      if (!s || !e || to <= from) return undefined
      const r = root.ownerDocument.createRange()
      r.setStart(s.node, s.offset)
      r.setEnd(e.node, e.offset)
      return r
    },
    offsetOf(node, offset) {
      if (node.nodeType === Node.TEXT_NODE) {
        const n = nodes.find((x) => x.node === node)
        return n ? n.start + offset : undefined
      }
      // 元素里的一个位置（例如选到段落末尾）：取它之后第一个可数的字
      const point = root.ownerDocument.createRange()
      point.setStart(node, offset)
      for (const n of nodes) if (point.comparePoint(n.node, 0) >= 0) return n.start
      return text.length
    }
  }
}
