import { isContentLocator, findTextQuote } from '@resource-manager/plugin-api/content-selection'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { z } from 'zod'
import type { CommandContext, CorePlugin } from '@resource-manager/plugin-api/core/contracts'
import { parseInput } from '@resource-manager/plugin-api/operations'
import { blocks } from './blocks'
import { bookOf, bookmarksOf, progressOf, MAX_INDEX_CHARS, type Position, type ReaderNode } from './model'
import { parseEpub } from './lib/parse'
import { queries } from './queries'

const positionInput = z.object({ id: z.string().min(1).max(200), sourceHash: z.string().min(1), chapter: z.string().min(1).max(1000), offset: z.number().int().min(0) }).strict()
function currentBook(ctx: CommandContext, id: string) {
  if (!ctx.query({ ids: [id] }).ids.includes(id)) throw new Error('电子书不存在或已移到回收站')
  const b = ctx.blocksOf(id), book = bookOf(b.epub?.data)
  if (!book || b.file?.data.hash !== book.sourceHash) throw new Error('电子书正在更新，请稍后再试')
  return book
}
function checkedPosition(ctx: CommandContext, args: z.infer<typeof positionInput>) {
  const book = currentBook(ctx, args.id), c = book.chapters.find(c => c.href === args.chapter)
  if (book.sourceHash !== args.sourceHash || !c || args.offset > c.length) throw new Error('原书或阅读位置已变化，请重新打开')
  return book
}
export const plugin: CorePlugin = {
  id: 'epub', version: 1, blocks, queries,
  systems: [{
    id: 'epub.anchor', priority: 24, has: ['anchor'], needs: ['annotate'],
    targetInputs: ['file.hash', 'epub'], outputs: ['place'],
    match: b => b.anchor.data.type === '内容摘录' && isContentLocator(b.anchor.data.locator)
      && b.anchor.data.locator.provider === 'epub.quote' && b.anchor.data.locator.version === 1,
    async run(ctx, _id, b) {
      const anchor = b.anchor.data
      const locator = anchor.locator as import('@resource-manager/plugin-api/content-selection').ContentLocator
      const target = ctx.blocksOf(String(anchor.target)), book = bookOf(target.epub?.data)
      const chapter = book?.chapters.find(c => c.href === locator.data.chapter)
      if (!book || !chapter || book.sourceHash !== locator.data.sourceHash || target.file?.data.hash !== book.sourceHash) return { place: { found: false } }
      const doc = JSON.parse(await readFile(ctx.abs(chapter.path), 'utf8')) as import('./model').ChapterDocument
      return { place: { found: !!findTextQuote(doc.text, {
        quote: String(anchor.quote), prefix: String(locator.data.prefix ?? ''),
        suffix: String(locator.data.suffix ?? ''), offset: Number(locator.data.from) || 0
      }) } }
    }
  }, {
    id: 'epub.read', priority: 5, has: ['file'], inputs: ['file.hash'], outputs: ['epub', 'epubtext'], concurrency: 1,
    match: b => String(b.file.data.ext).toLowerCase() === 'epub',
    async run(ctx, id, b) {
      const source = ctx.abs(String(b.file.data.path))
      if ((await stat(source)).size > 128 * 1024 * 1024) throw new Error('EPUB 超过 128 MiB，暂不支持')
      ctx.signal.throwIfAborted()
      const parsed = parseEpub(await readFile(source), String(b.file.data.hash))
      const dir = ctx.cacheDir('epub'), paths: string[] = [], assets = new Map<string, string>()
      const save = async (bytes: Uint8Array, ext: string) => {
        ctx.signal.throwIfAborted()
        const hash = createHash('sha256').update(bytes).digest('hex')
        const path = posix.join(dir, `${id}-${hash}.${ext}`), temporary = ctx.abs(`${path}.${randomUUID()}.tmp`)
        try { await writeFile(temporary, bytes); ctx.signal.throwIfAborted(); await rename(temporary, ctx.abs(path)) }
        finally { await rm(temporary, { force: true }) }
        return path
      }
      for (const [name, data] of parsed.images) {
        assets.set(name, await save(data.bytes, data.extension))
      }
      const rewrite = (nodes: ReaderNode[]) => { for (const node of nodes) if ('tag' in node) { if (node.image) node.image = assets.get(node.image); rewrite(node.children) } }
      for (let i = 0; i < parsed.documents.length; i++) {
        const doc = parsed.documents[i]; rewrite(doc.nodes)
        const path = await save(Buffer.from(JSON.stringify(doc)), 'json')
        paths.push(path); parsed.book.chapters[i].path = path
        ctx.progress((i + 1) / parsed.documents.length)
      }
      const truncated = parsed.text.length > MAX_INDEX_CHARS
      if (truncated) parsed.book.warnings.push('全文搜索和 AI 正文读取只索引前三百万字符；阅读器仍可阅读全书。')
      return {
        epub: { ...parsed.book, documents: paths, assets: [...assets.values()], ...(parsed.cover && assets.get(parsed.cover) ? { cover: assets.get(parsed.cover) } : {}) },
        epubtext: { content: parsed.text.slice(0, MAX_INDEX_CHARS), sourceHash: parsed.book.sourceHash, truncated }
      }
    }
  }, {
    // still 的现有产出者占用 10–15（含外部批注 14、视频片段 15）；装配时不能同优先级。
    id: 'epub.cover', priority: 16, has: ['file', 'epub'], inputs: ['epub'], outputs: ['still'],
    async run(_ctx, _id, b) { return { still: b.epub.data.cover ? { path: b.epub.data.cover, source: b.epub.seq } : null } }
  }],
  commands: {
    savePosition(ctx, input) {
      const args = parseInput(positionInput, input), book = checkedPosition(ctx, args)
      const { id, ...position } = args
      ctx.put(id, 'epubreading', { ...position, progress: progressOf(book, position), lastRead: Date.now() })
      return { label: '更新阅读位置' }
    },
    addBookmark(ctx, input) {
      const args = parseInput(positionInput.extend({ title: z.string().max(200).optional() }), input)
      const book = checkedPosition(ctx, args), items = bookmarksOf(ctx.blocksOf(args.id).epubbookmarks?.data.items)
      const existing = items.find(p => p.sourceHash === args.sourceHash && p.chapter === args.chapter && p.offset === args.offset)
      if (existing) return { label: '已有书签', result: { id: existing.id } }
      if (items.length >= 1000) throw new Error('一本书最多保存 1000 个书签')
      const position: Position = { sourceHash: args.sourceHash, chapter: args.chapter, offset: args.offset }
      const bookmark = { ...position, id: randomUUID(), title: args.title?.trim() || book.chapters.find(c => c.href === args.chapter)!.title, createdAt: Date.now() }
      ctx.put(args.id, 'epubbookmarks', { items: [...items, bookmark] })
      return { label: '添加书签', result: { id: bookmark.id } }
    },
    removeBookmark(ctx, input) {
      const { id, bookmarkId } = parseInput(z.object({ id: z.string().min(1), bookmarkId: z.string().min(1) }).strict(), input)
      currentBook(ctx, id)
      const items = bookmarksOf(ctx.blocksOf(id).epubbookmarks?.data.items).filter(p => p.id !== bookmarkId)
      if (items.length) ctx.put(id, 'epubbookmarks', { items }); else ctx.remove(id, 'epubbookmarks')
      return { label: '删除书签' }
    }
  }
}
