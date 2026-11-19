import { isEntityId } from './wikilink'

/** 同一次传输的多种表示；先选主体，再补来源，不能逐种创建素材。 */
export interface TransferFacts {
  internal: string
  files: { path: string; image: boolean }[]
  text: string
  html: string
  htmlText: string
  images: string[]
  uris: string[]
}
export type TransferPlan =
  | { kind: 'internal'; ids: string[] }
  | { kind: 'files' }
  | { kind: 'html'; text: string; html: string }
  | { kind: 'images'; urls: string[] }
  | { kind: 'links'; urls: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

export function webUrl(value: string): string | undefined {
  if (!/^https?:\/\/\S+$/i.test(value)) return undefined
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
export const imageUrl = (value: string): boolean => {
  try { return /\.(png|jpe?g|gif|webp|avif|tiff?|bmp|svg|heic|heif)$/i.test(new URL(value).pathname) } catch { return false }
}
export function uriList(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).flatMap(s => webUrl(s) ?? []))]
}

export function planTransfer(f: TransferFacts): TransferPlan {
  if (f.internal) {
    let ids: unknown
    try { ids = JSON.parse(f.internal) } catch { throw new Error('素材拖动数据无效') }
    if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string' && isEntityId(id))) throw new Error('素材拖动数据无效')
    return { kind: 'internal', ids: [...new Set(ids)] }
  }
  const text = f.text.trim(), body = f.htmlText.trim()
  // 真正的段落/标题不能因同时带图片数据而消失；本地文件拖入仍优先。
  const richText = f.html && body && !webUrl(body)
  if (f.files.length && (f.files.some(f => f.path || !f.image) || !richText)) return { kind: 'files' }
  if (f.html) {
    if (richText) return { kind: 'html', text: text || body, html: f.html }
    if (f.images.length) return { kind: 'images', urls: [...new Set(f.images)] }
    if (body) return { kind: 'html', text: text || body, html: f.html }
  }
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const urls = f.uris.length ? f.uris : lines.length && lines.every(s => webUrl(s)) ? uriList(text) : []
  if (urls.length) return { kind: urls.every(imageUrl) ? 'images' : 'links', urls }
  return text ? { kind: 'text', text: f.text } : { kind: 'empty' }
}
