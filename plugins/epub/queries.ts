import { z } from 'zod'
import { queryPageSchema, type QueryDefinition, type QueryContext } from '@resource-manager/plugin-api/queries'
import { bookOf, MAX_INDEX_CHARS } from './model'

const id = z.string().min(1).max(200)
const input = z.object({ id }).strict()
function book(ctx: QueryContext, id: string) {
  const value = bookOf(ctx.blocksOf(id, ['epub']).epub?.data)
  if (!value) throw new Error('[NOT_READY] 电子书尚未加工完成')
  return value
}
export const queries: QueryDefinition[] = [
  {
    name: 'chapters', title: '列出电子书章节', description: '按阅读顺序分页列出章节。chapter 从 1 开始；indexedLength 表示可经 read_chapter 读取的索引正文长度。',
    input, paginated: true,
    output: queryPageSchema(z.object({ chapter: z.number().int(), href: z.string(), title: z.string(), length: z.number().int(), indexedLength: z.number().int() }).strict()),
    run(ctx, args) {
      const b = book(ctx, args.id as string)
      return { ...ctx.page(b.chapters.map((c, i) => ({ chapter: i + 1, href: c.href, title: c.title, length: c.length, indexedLength: Math.max(0, Math.min(c.length, MAX_INDEX_CHARS - c.start)) }))) }
    }
  },
  {
    name: 'read_chapter', title: '读取电子书章节', description: '按章节分段读取已提取的正文。chapter 从 1 开始，offset 是章节内 UTF-16 偏移；nextOffset 不为 null 时可继续。索引最多三百万字符，truncated 表示该章后续未进入索引；不改变阅读进度。',
    input: input.extend({ chapter: z.number().int().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(8000).default(4000) }).strict(),
    output: z.object({ title: z.string(), chapter: z.number().int(), offset: z.number().int(), text: z.string(), total: z.number().int(), nextOffset: z.number().int().nullable(), truncated: z.boolean(), seq: z.number().int() }).strict(),
    run(ctx, args) {
      const { id, chapter, offset, limit } = args as { id: string; chapter: number; offset: number; limit: number }
      const c = book(ctx, id).chapters[chapter - 1]
      if (!c) throw new Error('[NOT_FOUND] 章节不存在')
      const available = Math.max(0, Math.min(c.length, MAX_INDEX_CHARS - c.start))
      if (offset > available || !available && c.length > 0) throw new Error('[OUT_OF_RANGE] 位置超出已索引的章节正文')
      const chunk = ctx.readContent({ id, kind: 'epubtext', field: 'content', offset: c.start + offset, limit: Math.max(1, Math.min(limit, available - offset)) })
      const text = offset < available ? chunk.text.slice(0, available - offset) : ''
      return { title: c.title, chapter, offset, text, total: c.length, nextOffset: offset + text.length < available ? offset + text.length : null, truncated: available < c.length, seq: chunk.seq }
    }
  }
]
