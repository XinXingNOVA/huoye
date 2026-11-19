// 粘贴、拖进来的 HTML → Markdown。只在 HTML 里真有格式时才转：
// 从代码编辑器、终端复制时剪贴板里也有 HTML，但只是一堆带样式的 <span>，那时用纯文字。

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/** 值得保留的格式。 */
const FORMATTED = /<(h[1-6]|strong|b|em|i|a\s|ul|ol|li|blockquote|pre|code|table|img|hr|del|s)\b/i

let service: TurndownService | undefined

function turndown(): TurndownService {
  if (!service) {
    service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' })
    service.use(gfm)
    service.remove(['script', 'style', 'noscript', 'title', 'meta', 'link', 'head', 'iframe', 'button', 'input', 'select', 'textarea'])
  }
  return service
}

/** 没有值得保留的格式、或者转出来是空的，返回 undefined（用纯文字）。 */
export function htmlToMarkdown(html: string): string | undefined {
  if (!FORMATTED.test(html)) return undefined
  const md = turndown()
    .turndown(html)
    // 列表符号后面只留一个空格（turndown 按缩进对齐会留三个）
    .replace(/^(\s*)([-*+]|\d+\.)\s{2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return md || undefined
}
