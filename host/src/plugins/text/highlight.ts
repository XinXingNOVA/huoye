import { marksIn } from '../../shared/search'

/** 公式作为排版整体保留；不向 KaTeX 的 MathML 或字形结构里塞入 mark。 */
export function markDocTerms(root: HTMLElement, terms: string[]): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement?.closest('.katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  })
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  for (const node of nodes) {
    const marks = marksIn(node.data, terms)
    if (!marks.length) continue
    const frag = root.ownerDocument.createDocumentFragment()
    let at = 0
    for (const [start, end] of marks) {
      frag.append(node.data.slice(at, start))
      const mark = root.ownerDocument.createElement('mark')
      mark.textContent = node.data.slice(start, end)
      frag.append(mark)
      at = end
    }
    frag.append(node.data.slice(at)); node.replaceWith(frag)
  }
}
