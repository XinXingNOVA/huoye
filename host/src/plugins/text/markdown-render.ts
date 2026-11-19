import MarkdownIt from 'markdown-it'
import { wikiLinkAt, wikiLinkLabel, type WikiLink } from '../../shared/wikilink'
import { textMath } from './math'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(textMath)
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx]
  const src = md.utils.escapeHtml(String(t.attrGet('src') ?? ''))
  return `<a class="md-image" href="${src}">图片：${md.utils.escapeHtml(t.content || src)}</a>`
}

// [[…]]、![[…]]：排在 Markdown 自己的链接、图片之前认
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const c = state.src.charCodeAt(state.pos)
  if (c !== 0x5b && c !== 0x21) return false
  const l = wikiLinkAt(state.src, state.pos)
  if (!l) return false
  if (!silent) state.push('wikilink', '', 0).meta = { link: l }
  state.pos += l.length
  return true
})
md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
  const l = tokens[idx].meta!.link as WikiLink
  const esc = md.utils.escapeHtml
  const label = wikiLinkLabel(l)
  if (!env?.live) return l.embed ? `<span class="embed-static">${esc(label || '嵌入')}</span>` : `<span class="wikilink static">${esc(label || '链接')}</span>`
  const attrs = `data-ref="${esc(l.target)}"${l.label ? ` data-label="${esc(l.label)}"` : ''}`
  return l.embed ? `<span class="embed-slot" data-embed="" ${attrs}></span>` : `<span class="wikilink-slot" ${attrs}></span>`
}

export function renderTextMarkdown(content: string, live = false): string {
  return md.render(content, { live })
}
