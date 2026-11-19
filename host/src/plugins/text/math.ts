import type { MarkdownIt } from 'markdown-it'
import { tex } from '@mdit/plugin-tex'
import { renderToString } from 'katex'

// 文字与聊天使用相同语法；各插件独立装配，不依赖另一个插件的启停。
export function textMath(markdown: MarkdownIt): void {
  const escape = markdown.utils.escapeHtml
  const rawMath = (source: string, block: boolean) => block
    ? `<pre class="text-math-source">${escape(source)}</pre>\n`
    : `<span class="text-math-source">${escape(source)}</span>`
  function math(content: string, displayMode: boolean): string {
    // 只处理有界公式；不共享宏，不允许 HTML、外部图片或链接扩展。
    if (content.length > 8000) return rawMath(content, displayMode)
    try {
      const html = renderToString(content, {
        displayMode, output: 'htmlAndMathml', throwOnError: true,
        trust: false, strict: 'ignore', maxExpand: 200, maxSize: 20, macros: {}
      })
      return displayMode ? `<div class="text-math-block">${html}</div>\n` : html
    } catch { return rawMath(content, displayMode) }
  }
  markdown.use(tex, { delimiters: 'all', mathFence: true, render: math })

  // 卡片截断或另存的回答可能没有闭合 $$，保持源码直到补全。
  markdown.core.ruler.after('block', 'text_pending_math', state => {
    const lines = state.src.split('\n')
    for (const token of state.tokens) {
      if (token.type !== 'math_block' || token.markup !== '$$' || !token.map) continue
      const [start, end] = token.map, last = lines[end - 1]?.trimEnd() ?? ''
      const closed = last.endsWith('$$') && (end > start + 1 || last.indexOf('$$') !== last.length - 2)
      if (!closed) { token.type = 'text_pending_math'; token.content = lines.slice(start, end).join('\n') }
    }
  })
  markdown.renderer.rules.text_pending_math = (tokens, index) => rawMath(tokens[index].content, true)

  // 尚未闭合的 \( / \[ 保留原文，避免 Markdown 把开头的反斜线当转义吞掉。
  markdown.inline.ruler.before('escape', 'text_pending_bracket', (state, silent) => {
    const opening = state.src.slice(state.pos, state.pos + 2)
    if (opening !== '\\(' && opening !== '\\[') return false
    const rest = state.src.slice(state.pos, state.posMax), closing = opening === '\\(' ? '\\)' : '\\]'
    if (rest.includes(closing)) return false
    if (!silent) { const token = state.push('text_pending_inline', '', 0); token.content = rest }
    state.pos = state.posMax
    return true
  })
  markdown.renderer.rules.text_pending_inline = (tokens, index) => rawMath(tokens[index].content, false)
}
