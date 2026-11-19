import { DOMParser, type Element as XmlElement, type Document as XmlDocument } from '@xmldom/xmldom'
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5'
import { bookLink, readArchive, textOf } from './archive'
import { readingTags, type Book, type ChapterDocument, type ReaderNode, type ReadingTag, type TocEntry } from '../model'

type Element = XmlElement
const all = (node: Element | XmlDocument, name: string): Element[] => Array.from(node.getElementsByTagName('*')).filter(e => e.localName === name)
const value = (node: Element | XmlDocument, name: string) => all(node, name).map(n => n.textContent?.trim()).filter(Boolean).join('、')
function xml(text: string): XmlDocument {
  if (/<!ENTITY\b/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('不支持带自定义实体的 EPUB XML')
  return new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(`EPUB XML 无效：${message.slice(0, 150)}`) } }).parseFromString(text, 'application/xml')
}
const raster = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])
const blockTags = new Set(['div', 'section', 'article', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'figure', 'figcaption', 'dt', 'dd', 'hr', 'br'])
const allowed = new Set<string>(readingTags)
const dropped = new Set(['head', 'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'canvas', 'template', 'noscript'])
const attr = (node: Html.Element, name: string) => node.attrs.find(a => a.name === name)?.value ?? ''
const htmlText = (node: Html.Node): string => node.nodeName === '#text' ? (node as Html.TextNode).value : 'childNodes' in node ? node.childNodes.map(htmlText).join('') : ''
function htmlElements(node: Html.Node, match: (e: Html.Element) => boolean): Html.Element[] {
  const out: Html.Element[] = []
  const visit = (n: Html.Node, depth: number) => {
    if (depth > 100) throw new Error('EPUB 章节嵌套过深')
    if ('tagName' in n && match(n)) out.push(n)
    if ('childNodes' in n) n.childNodes.forEach(c => visit(c, depth + 1))
  }
  visit(node, 0); return out
}
export interface ParsedBook { book: Book; documents: ChapterDocument[]; images: Map<string, { bytes: Uint8Array; extension: string }>; cover?: string; text: string }

export function parseEpub(bytes: Uint8Array, sourceHash: string): ParsedBook {
  const files = readArchive(bytes)
  const read = (name: string) => { const data = files.get(name); if (!data) throw new Error(`EPUB 缺少资源：${name}`); return textOf(data) }
  const container = xml(read('META-INF/container.xml'))
  const rootfile = all(container, 'rootfile').find(e => e.getAttribute('media-type') === 'application/oebps-package+xml') ?? all(container, 'rootfile')[0]
  const opf = bookLink('container.xml', rootfile?.getAttribute('full-path') ?? '')?.path
  if (!opf || !files.has(opf)) throw new Error('EPUB 缺少书籍描述文件')
  const doc = xml(read(opf)), metadata = all(doc, 'metadata')[0]
  if (!metadata) throw new Error('EPUB 缺少元信息')
  if (all(metadata, 'meta').some(e => e.getAttribute('property') === 'rendition:layout' && e.textContent?.trim() === 'pre-paginated')) throw new Error('本版支持流式排版，暂不支持固定版式 EPUB')
  const items = all(doc, 'item').map(e => ({ id: e.getAttribute('id') ?? '', href: bookLink(opf, e.getAttribute('href') ?? '')?.path, mime: e.getAttribute('media-type') ?? '', properties: (e.getAttribute('properties') ?? '').split(/\s+/) }))
  const manifest = new Map(items.map(i => [i.id, i]))
  const refs = all(doc, 'itemref')
  if (refs.some(e => (e.getAttribute('properties') ?? '').includes('rendition:layout-pre-paginated'))) throw new Error('本版暂不支持固定版式章节')
  const spine = refs.map(e => manifest.get(e.getAttribute('idref') ?? ''))
  if (!spine.length || spine.length > 1500 || spine.some(i => !i?.href || !['application/xhtml+xml', 'text/html'].includes(i.mime))) throw new Error('EPUB 阅读顺序无效或包含不支持的章节格式')
  const hrefs = spine.map(i => i!.href!)
  if (new Set(hrefs).size !== hrefs.length) throw new Error('EPUB 阅读顺序包含重复章节')
  const encrypted = new Set<string>()
  if (files.has('META-INF/encryption.xml')) {
    for (const e of all(xml(read('META-INF/encryption.xml')), 'CipherReference')) {
      const path = bookLink('root.xml', e.getAttribute('URI') ?? '')?.path
      if (path) encrypted.add(path)
    }
  }
  if (hrefs.some(h => encrypted.has(h))) throw new Error('这本 EPUB 的正文已加密，暂不支持 DRM 电子书')
  const warnings = new Set<string>()
  const toc: TocEntry[] = []
  const addToc = (title: string, base: string, href: string, depth: number) => {
    const link = bookLink(base, href), chapter = link ? hrefs.indexOf(link.path) : -1
    if (chapter >= 0 && title.trim()) toc.push({ title: title.trim().slice(0, 300), chapter, depth: Math.min(depth, 12), ...(link?.anchor ? { anchor: link.anchor } : {}) })
  }
  const nav = items.find(i => i.properties.includes('nav') && i.href && files.has(i.href))
  if (nav?.href) {
    const html = parse(read(nav.href))
    const navigation = htmlElements(html, e => e.tagName === 'nav' && attr(e, 'type').split(/\s+/).includes('toc'))[0]
      ?? htmlElements(html, e => e.tagName === 'nav' && attr(e, 'epub:type').split(/\s+/).includes('toc'))[0]
      ?? htmlElements(html, e => e.tagName === 'nav')[0]
    if (navigation) for (const a of htmlElements(navigation, e => e.tagName === 'a')) {
      let depth = -1, parent: Html.ParentNode | null = a.parentNode
      while (parent && parent !== navigation) { if ('tagName' in parent && parent.tagName === 'ol') depth++; parent = 'parentNode' in parent ? parent.parentNode : null }
      addToc(htmlText(a), nav.href, attr(a, 'href'), Math.max(0, depth))
    }
  }
  if (!toc.length) {
    const ncx = manifest.get(all(doc, 'spine')[0]?.getAttribute('toc') ?? '') ?? items.find(i => i.mime === 'application/x-dtbncx+xml')
    if (ncx?.href && files.has(ncx.href)) for (const point of all(xml(read(ncx.href)), 'navPoint')) {
      let depth = 0, parent = point.parentNode
      while (parent && 'localName' in parent) { if (parent.localName === 'navPoint') depth++; parent = parent.parentNode }
      addToc(value(all(point, 'navLabel')[0] ?? point, 'text'), ncx.href, all(point, 'content')[0]?.getAttribute('src') ?? '', depth)
    }
  }
  if (toc.length > 3000) throw new Error('EPUB 目录条目过多')
  const images = new Map<string, { bytes: Uint8Array; extension: string }>()
  const imageItems = new Map(items.filter(i => i.href).map(i => [i.href!, i]))
  const image = (base: string, href: string): string | undefined => {
    const path = bookLink(base, href)?.path, item = path ? imageItems.get(path) : undefined
    if (!path || !item || !raster.has(item.mime) || !files.has(path) || encrypted.has(path)) { warnings.add('部分图片格式或外部资源未显示'); return }
    images.set(path, { bytes: files.get(path)!, extension: item.mime === 'image/jpeg' ? 'jpg' : item.mime.slice(6) }); return path
  }
  const coverId = all(metadata, 'meta').find(e => e.getAttribute('name') === 'cover')?.getAttribute('content')
  const coverItem = items.find(i => i.properties.includes('cover-image')) ?? (coverId ? manifest.get(coverId) : undefined)
  let cover = coverItem?.href ? image(opf, relativeBookHref(opf, coverItem.href)) : undefined
  let joined = ''
  const documents: ChapterDocument[] = []
  const chapters: Book['chapters'] = []
  for (let index = 0; index < hrefs.length; index++) {
    const href = hrefs[index], html = parse(read(href))
    const body = htmlElements(html, e => e.tagName === 'body')[0]
    let text = '', nodesCount = 0
    const newline = () => { if (text && !text.endsWith('\n')) text += '\n' }
    const walk = (node: Html.Node, depth: number, preserve = false): ReaderNode[] => {
      if (++nodesCount > 100_000 || depth > 80) throw new Error('EPUB 章节内容过于复杂')
      if (node.nodeName === '#text') {
        const raw = (node as Html.TextNode).value, chunk = preserve ? raw : raw.replace(/\s+/g, ' ')
        if (!chunk || (!chunk.trim() && (!text || text.endsWith('\n')))) return []
        const start = text.length; text += chunk
        return [{ text: chunk, start }]
      }
      if (!('tagName' in node) || dropped.has(node.tagName)) return []
      const tag = node.tagName, anchor = attr(node, 'id') || attr(node, 'name')
      if (blockTags.has(tag)) newline()
      if (tag === 'img' || tag === 'image') {
        const src = image(href, attr(node, 'src') || attr(node, 'href'))
        return src ? [{ tag: 'img', image: src, alt: attr(node, 'alt').slice(0, 500), children: [], ...(anchor ? { anchor } : {}) }] : []
      }
      const children = node.childNodes.flatMap(n => walk(n, depth + 1, preserve || tag === 'pre'))
      if (blockTags.has(tag)) newline()
      const out: Exclude<ReaderNode, { text: string }> = { tag: allowed.has(tag) ? tag as ReadingTag : 'div', children, ...(anchor ? { anchor: anchor.slice(0, 500) } : {}) }
      if (tag === 'a') {
        const target = attr(node, 'href'), link = bookLink(href, target), chapter = link ? hrefs.indexOf(link.path) : -1
        if (chapter >= 0) out.link = { chapter, ...(link?.anchor ? { anchor: link.anchor } : {}) }
        else if (/^https?:\/\//i.test(target)) out.link = { external: target }
      }
      for (const field of ['colspan', 'rowspan'] as const) { const n = Number(attr(node, field)); if (Number.isInteger(n) && n > 0 && n <= 50) out[field] = n }
      return [out]
    }
    const nodes = body ? body.childNodes.flatMap(n => walk(n, 0)) : []
    if (!nodes.length) warnings.add('个别章节没有可显示的正文')
    const title = toc.find(t => t.chapter === index && !t.anchor)?.title ?? toc.find(t => t.chapter === index)?.title
      ?? htmlElements(html, e => ['h1', 'h2'].includes(e.tagName)).map(htmlText).find(t => t.trim())?.trim().slice(0, 300) ?? `第 ${index + 1} 章`
    chapters.push({ href, title, path: '', start: joined.length, length: text.length })
    documents.push({ version: 1, sourceHash, href, nodes, text })
    joined += text + '\n'
    if (joined.length > 10_000_000) throw new Error('EPUB 正文超过一千万字，暂不支持')
  }
  if (!toc.length) toc.push(...chapters.map((c, chapter) => ({ chapter, title: c.title, depth: 0 })))
  if (!cover) {
    const guide = all(doc, 'reference').find(e => e.getAttribute('type') === 'cover')
    const coverPage = guide ? bookLink(opf, guide.getAttribute('href') ?? '')?.path : hrefs[0]
    const first = documents.find(d => d.href === coverPage)
    const findImage = (nodes: ReaderNode[]): string | undefined => { for (const n of nodes) if ('tag' in n) { const found = n.image ?? findImage(n.children); if (found) return found }; return undefined }
    if (first) cover = findImage(first.nodes)
  }
  return { book: { title: value(metadata, 'title').slice(0, 500) || '未命名电子书', author: value(metadata, 'creator').slice(0, 1000),
    language: value(metadata, 'language').slice(0, 100), publisher: value(metadata, 'publisher').slice(0, 500), description: value(metadata, 'description').slice(0, 10000),
    sourceHash, chapters, toc, characters: joined.length, warnings: [...warnings] }, documents, images, cover, text: joined }
}

function relativeBookHref(base: string, target: string): string {
  // 容器路径在 XML 中为 URI；逐段编码避免 # / % 被当作分隔符。
  const depth = base.split('/').length - 1
  return '../'.repeat(depth) + target.split('/').map(encodeURIComponent).join('/')
}
