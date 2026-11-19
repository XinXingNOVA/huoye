/** 插件自有的阅读模型；位置使用规范化正文的 UTF-16 偏移，不冒充 EPUB CFI 或纸书页码。 */
export const MAX_INDEX_CHARS = 3_000_000
export interface Chapter {
  href: string; title: string; path: string; start: number; length: number
}
export interface TocEntry { title: string; chapter: number; anchor?: string; depth: number }
export interface Book {
  title: string; author: string; language: string; publisher: string; description: string
  sourceHash: string; chapters: Chapter[]; toc: TocEntry[]; characters: number; warnings: string[]
}
export const readingTags = ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'ruby', 'rt', 'rp', 'pre', 'code', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption', 'span', 'a', 'img'] as const
export type ReadingTag = typeof readingTags[number]
export type ReaderNode = { text: string; start: number } | {
  tag: ReadingTag; children: ReaderNode[]; anchor?: string; image?: string; alt?: string
  link?: { chapter: number; anchor?: string } | { external: string }; colspan?: number; rowspan?: number
}
export interface ChapterDocument { version: 1; sourceHash: string; href: string; nodes: ReaderNode[]; text: string }
export interface Position { sourceHash: string; chapter: string; offset: number }
export interface Bookmark extends Position { id: string; title: string; createdAt: number }
export function bookOf(value: unknown): Book | undefined {
  const b = value as Book | undefined
  return b && typeof b.sourceHash === 'string' && Array.isArray(b.chapters) && b.chapters.length ? b : undefined
}
export function positionOf(book: Book, value: unknown): Position {
  const p = value as Partial<Position> | undefined
  const chapter = p?.sourceHash === book.sourceHash ? book.chapters.find(c => c.href === p.chapter) : undefined
  const c = chapter ?? book.chapters[0]
  return { sourceHash: book.sourceHash, chapter: c.href, offset: chapter && Number.isFinite(p?.offset) ? Math.max(0, Math.min(c.length, Math.floor(p!.offset!))) : 0 }
}
export function progressOf(book: Book, p: Position): number {
  const c = book.chapters.find(c => c.href === p.chapter)
  if (c && c === book.chapters.at(-1) && p.offset >= c.length) return 1
  return c && book.characters ? Math.max(0, Math.min(1, (c.start + p.offset) / book.characters)) : 0
}
export function bookmarksOf(value: unknown): Bookmark[] {
  return Array.isArray(value) ? value.filter((v): v is Bookmark => v && typeof v.id === 'string' && typeof v.chapter === 'string' && typeof v.sourceHash === 'string' && typeof v.title === 'string' && Number.isInteger(v.offset) && v.offset >= 0 && Number.isFinite(v.createdAt)).slice(0, 1000) : []
}
