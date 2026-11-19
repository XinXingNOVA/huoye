// 有界的读取服务：复用查询、字段定义与全文索引，不带 MCP/界面状态。
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { parseInput, readContentSchema, readItemSchema, searchPageSchema, readItemsSchema, facetPageSchema, inventoryLimits,
  type ContentChunk, type ItemDetails, type LibraryDescription, type ReadContentRequest, type ReadItemRequest,
  type SearchPageRequest, type SearchPageResult, type ReadItemsRequest, type FacetPageRequest, type FacetPage } from '../shared/automation'
import { searchesOf } from '../shared/query'
import { summaryTitle, titleCandidates } from '../shared/title'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import { readProjectedItems } from './projected-items'
import { runFacetPage, runQuery } from './query'
import { snippetOf } from './search'
import { describeIngestMetadata } from './ingest-metadata'
import { describeOperations } from './operations'
import { describeQueries } from './business-queries'
import { QUERY_LIMITS } from '../shared/business-queries'

export class Reading {
  private readonly session = randomUUID()
  constructor(private lib: Library, private reg: Registry, private store: Store,
    private processing: (id: string) => ItemDetails['processing'] = () => 'idle') {}

  describe(): LibraryDescription {
    return {
      libraryId: this.lib.id, name: basename(this.lib.root),
      kinds: this.reg.allKinds().map(({ validate: _, ...kind }) => kind),
      operations: describeOperations(this.reg),
      ingestMetadata: describeIngestMetadata(this.reg),
      queries: describeQueries(this.reg.plugins),
      limits: { search: 50, content: 12000, inventory: inventoryLimits, queries: QUERY_LIMITS }
    }
  }

  private page(key: unknown, cursor?: string) {
    const hash = createHash('sha256').update(JSON.stringify(key)).digest('hex')
    // 连接内的总变化数也涵盖回收站、恢复和模板；重启后游标必失效，避免静默漏项。
    const revision = `${this.session}:${this.lib.db.prepare('SELECT total_changes()').pluck().get()}`
    let offset = 0
    if (cursor) {
      let page: { hash: string; revision: string; offset: number }
      try { page = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw new Error('[INVALID_CURSOR] 游标格式不正确') }
      if (!page || page.hash !== hash || page.revision !== revision || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 10000000) {
        throw new Error('[STALE_CURSOR] 查询条件或仓库已变化，请从第一页重新搜索')
      }
      offset = page.offset
    }
    return { offset, cursorAt: (next: number) => Buffer.from(JSON.stringify({ hash, revision, offset: next })).toString('base64url') }
  }

  search(input: SearchPageRequest): SearchPageResult {
    const { query, limit, cursor } = parseInput(searchPageSchema, input)
    const { offset, cursorAt } = this.page(query, cursor)
    const { ids } = runQuery(this.lib.db, this.reg, query, { limit: limit + 1, offset })
    // 一次只取一项正文，避免一页搜索结果同时把几十份 PDF 装进内存。
    const items = ids.slice(0, limit).map(id => {
      const v = this.item(id)
      return { id, title: summaryTitle(v.blocks, k => this.reg.kind(k), v.id), titleCandidates: titleCandidates(v.blocks, k => this.reg.kind(k)), kinds: Object.keys(v.blocks), snippet: snippetOf(this.reg, v.blocks, searchesOf(query)) }
    })
    return { items, nextCursor: ids.length > limit ? cursorAt(offset + limit) : null }
  }

  project(input: ReadItemsRequest) {
    const { ids, kinds, offset } = parseInput(readItemsSchema, input)
    if (offset > ids.length) throw new Error('[INVALID_OFFSET] offset 超出输入 ID 列表范围')
    for (const k of kinds) if (!this.reg.kind(k)) throw new Error('[INVALID_INPUT] 本库没有数据块定义：' + k)
    return this.lib.db.transaction(() => readProjectedItems(this.lib.db, ids, [...new Set(kinds)], offset))()
  }

  facet(input: FacetPageRequest): FacetPage {
    const { kind, field, query, cursor, limit } = parseInput(facetPageSchema, input)
    const { offset, cursorAt } = this.page(['facet', kind, field, query], cursor)
    const { hasMore, ...stats } = runFacetPage(this.lib.db, this.reg, kind, field, query, limit, offset)
    return { ...stats, nextCursor: hasMore ? cursorAt(offset + limit) : null }
  }

  private item(id: string) {
    const item = this.store.get([id])[0]
    if (!item) throw new Error('[NOT_FOUND] 素材不存在')
    return item
  }

  itemDetails(input: ReadItemRequest): ItemDetails {
    const { id, kinds, offset, limit } = parseInput(readItemSchema, input)
    const item = this.item(id)
    const fields: ItemDetails['fields'] = []
    for (const [kind, block] of Object.entries(item.blocks)) {
      if (kinds && !kinds.includes(kind)) continue
      const def = this.reg.kind(kind)
      for (const [field, value] of Object.entries(block.data)) {
        const f = def?.fields[field]
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        const truncated = text.length > 300
        const starts = f?.pageOffsets ? block.data[f.pageOffsets] : undefined
        fields.push({ kind, field, title: `${def?.title ?? kind} · ${f?.title ?? field}`, seq: block.seq,
          type: f?.type ?? 'json', preview: truncated ? text.slice(0, 300) : value, truncated,
          ...(Array.isArray(starts) ? { pages: starts.length } : {}) })
      }
    }
    fields.sort((a, b) => a.kind.localeCompare(b.kind) || a.field.localeCompare(b.field))
    return { id, title: summaryTitle(item.blocks, k => this.reg.kind(k), item.id), titleCandidates: titleCandidates(item.blocks, k => this.reg.kind(k), kinds), createdAt: item.createdAt, deletedAt: item.deletedAt,
      processing: item.deletedAt ? 'idle' : this.processing(id), failures: item.failures,
      fields: fields.slice(offset, offset + limit), nextOffset: offset + limit < fields.length ? offset + limit : null }
  }

  content(input: ReadContentRequest): ContentChunk {
    const { id, kind, field, page, offset, limit, expectedSeq } = parseInput(readContentSchema, input)
    const block = this.item(id).blocks[kind]
    const def = this.reg.kind(kind)?.fields[field]
    if (!block || block.data[field] === undefined) throw new Error('[CONTENT_UNAVAILABLE] 这个字段暂无内容，请用 read_item 检查记录与加工状态')
    if (expectedSeq !== undefined && expectedSeq !== block.seq) throw new Error('[CONTENT_CHANGED] 内容已变化，请重新读取首段')
    const value = block.data[field]
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    const starts = def?.pageOffsets ? block.data[def.pageOffsets] as number[] | undefined : undefined
    if (page !== undefined && (!Array.isArray(starts) || !Number.isInteger(starts[page - 1]))) throw new Error('[INVALID_PAGE] 该字段不支持这个页码')
    const text = page === undefined ? raw : raw.slice(starts![page - 1], starts![page] ?? raw.length)
    if (offset > text.length) throw new Error('[INVALID_OFFSET] 偏移超过内容长度')
    let end = Math.min(text.length, offset + limit)
    // 不把代理对截成两个无效字符；偏移仍和 PDF/阅读器共享 UTF-16 坐标。
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end++
    const next = end < text.length ? { id, kind, field, ...(page === undefined ? {} : { page }), offset: end, limit, expectedSeq: block.seq } : null
    return { id, kind, field, seq: block.seq, format: typeof value === 'string' ? def?.format ?? 'text' : 'json',
      ...(page === undefined ? {} : { page }), ...(starts ? { pages: starts.length } : {}), offset, total: text.length, text: text.slice(offset, end), next }
  }
}
