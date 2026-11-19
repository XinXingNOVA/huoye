import { isContentLocator } from '../../plugin-api/content-selection'
import { pdfLocationData } from './location'
// PDF 插件（设计文档 11.11）：读出页数、标题作者，第一页作代表图（缩略图由预览插件接上），
// 抽出文字（全文搜索自动接上）。都在核心进程里用 pdf.js 做，不依赖外部程序。

import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'
import type { CorePlugin } from '../../plugin-api/core/contracts'
import type { Blocks } from '../../shared/blocks'
import { blocks, readingPosition } from './blocks'
import { z } from 'zod'
import { closePdf, openPdf, pageText, renderPage } from './lib/pdfjs'

/** 代表图最长边。 */
const STILL_SIZE = 1600
/** 抽文字最多读这么多页、留这么多字：再多的书也够搜了，不让一本书占满全文索引。 */
const MAX_PAGES = 2000
const MAX_CHARS = 3_000_000

const isPdf = (b: Blocks) => String(b.file.data.ext) === 'pdf'
const pathOf = (abs: (rel: string) => string, b: Blocks) => abs(String(b.file.data.path))

const readingInput = z.object({ id: z.string().min(1), hash: z.string().min(1), page: z.number().finite(), offset: z.number().finite(), lastRead: z.number().positive().finite() }).strict()

export const pdfPlugin: CorePlugin = {
  id: 'pdf',
  version: 1,
  blocks,
  commands: {
    saveReading(ctx, input) {
      const value = readingInput.parse(input)
      const result = { label: '保存阅读进度' }
      if (!ctx.query({ ids: [value.id], scope: 'all' }).ids.length) return result
      const b = ctx.blocksOf(value.id)
      // 和写入在同一个命令事务中检查，迟到的旧视图不能覆盖新进度或换版后的原件。
      if (!b.pdf || b.file?.data.hash !== value.hash || Number(b.pdfreading?.data.lastRead) >= value.lastRead) return result
      ctx.put(value.id, 'pdfreading', { ...readingPosition(value, Number(b.pdf.data.pages) || 1), lastRead: value.lastRead })
      return result
    }
  },
  systems: [
    {
      id: 'pdf.anchor', priority: 23, has: ['anchor'], needs: ['annotate'],
      targetInputs: ['file.hash', 'pdf'],
      match: (b) => b.anchor.data.type === 'PDF摘录' || (b.anchor.data.type === '内容摘录' && isContentLocator(b.anchor.data.locator) && b.anchor.data.locator.provider === 'pdf.quote' && b.anchor.data.locator.version === 1), outputs: ['place'],
      async run(ctx, _id, b) {
        const a = b.anchor.data
        const target = ctx.blocksOf(String(a.target))
        if (a.type === '内容摘录') {
          const data = isContentLocator(a.locator) && pdfLocationData(a.locator)
          return {place:{found:!!data && data.sourceHash===target.file?.data.hash && !!target.pdf && data.fragments.every(f=>f.page<=Number(target.pdf.data.pages))}}
        }
        const parts = a.fragments as { page: number }[]
        return { place: { found: a.sourceHash === target.file?.data.hash && !!target.pdf && parts.every((p) => p.page <= Number(target.pdf.data.pages)) } }
      }
    },
    {
      id: 'pdf.probe',
      priority: 0,
      has: ['file'],
      // 只看文件的内容：改名不重做（设计文档 11.14）
      inputs: ['file.hash'],
      match: isPdf,
      outputs: ['pdf'],
      async run(ctx, _id, b) {
        const doc = await openPdf(pathOf(ctx.abs, b))
        try {
          const first = (await doc.getPage(1)).getViewport({ scale: 1 })
          const info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>
          const text = (k: string) => (typeof info[k] === 'string' && (info[k] as string).trim() ? { [k.toLowerCase()]: (info[k] as string).trim() } : {})
          return { pdf: { pages: doc.numPages, width: Math.round(first.width), height: Math.round(first.height), ...text('Title'), ...text('Author') } }
        } finally {
          await closePdf(doc)
        }
      }
    },
    {
      // 代表图：第一页（图片是 10，视频是 12）
      id: 'pdf.still',
      priority: 11,
      has: ['file', 'pdf'],
      inputs: ['file.hash'],
      outputs: ['still'],
      concurrency: 2,
      async run(ctx, id, b) {
        const doc = await openPdf(pathOf(ctx.abs, b))
        try {
          const rel = posix.join(ctx.cacheDir('stills'), `${id}.jpg`)
          const bytes = await renderPage(doc, 1, STILL_SIZE)
          const temporary = ctx.abs(`${rel}.${randomUUID()}.tmp`)
          try {
            ctx.signal.throwIfAborted()
            await writeFile(temporary, bytes, { flag: 'wx' })
            ctx.signal.throwIfAborted()
            // 缩略图可能正在 mmap 读取旧 JPEG；不得原位截断，完成后原子替换。
            await rename(temporary, ctx.abs(rel))
          } finally { await rm(temporary, { force: true }) }
          return { still: { path: rel, source: b.file.seq } }
        } finally {
          await closePdf(doc)
        }
      }
    },
    {
      id: 'pdf.text',
      priority: 30,
      has: ['file', 'pdf'],
      inputs: ['file.hash'],
      outputs: ['pdftext'],
      concurrency: 1,
      async run(ctx, _id, b) {
        const doc = await openPdf(pathOf(ctx.abs, b))
        try {
          let content = ''
          const pages: number[] = []
          const n = Math.min(doc.numPages, MAX_PAGES)
          for (let i = 1; i <= n && content.length < MAX_CHARS; i++) {
            if (ctx.signal.aborted) throw new Error('取消了')
            pages.push(content.length)
            content += (await pageText(doc, i)) + '\n\n'
            ctx.progress(i / n)
          }
          // 扫描版没有文字层
          return { pdftext: content.trim() ? { content: content.slice(0, MAX_CHARS), pages, source: b.file.seq } : null }
        } finally {
          await closePdf(doc)
        }
      }
    }
  ],
  aspect: {
    priority: 15,
    get: (b) => {
      const p = b.pdf?.data
      return p && Number(p.height) ? Number(p.width) / Number(p.height) : undefined
    }
  }
}

export { pdfPlugin as plugin }
