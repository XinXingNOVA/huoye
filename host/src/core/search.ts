// 全文索引（设计文档 11.8）：插件在字段上声明"可全文搜索"，宿主随写入维护索引，和字段索引一样。
//
// 中文按字切开，查询时一个词是一串相邻的字（短语）：搜"留白"就是原文里有"留白"这两个字连在一起，
// 和 ⌘F 一样，不依赖词典，也不会因为分词不同而漏掉。西文按词，最后一个词按前缀匹配，忽略大小写和变音符号。
// 索引在 derived.db（可重建）：删掉、或者可搜索的字段变了，打开时重建。

import type Database from 'better-sqlite3'
import type { BlockData, BlockKind, Blocks } from '../shared/blocks'
import { searchesField, type Snippet, type TextSearch } from '../shared/query'
import { marksIn, searchTerms } from '../shared/search'
import { plainOfMarkdown } from '../shared/markdown'
import type { Registry } from './registry'

/** 切字方式变了就加一，打开时重建索引。 */
const VERSION = 1

const CJK_CHAR = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]'
const CJK = new RegExp(`(${CJK_CHAR})`, 'gu')
const IS_CJK = new RegExp(`^${CJK_CHAR}$`, 'u')
const WORD = /[\p{L}\p{N}]+/gu

/** 写进索引的文字：中日韩的字之间加上空格，每个字成为一个词。 */
const spaced = (text: string) => text.replace(CJK, ' $1 ')

/** 一个词 → FTS5 的短语查询；里面没有字母数字的（只有标点）返回 undefined。 */
export function phraseOf(term: string): string | undefined {
  const tokens = spaced(term).match(WORD)
  if (!tokens?.length) return undefined
  const last = tokens[tokens.length - 1]
  // 最后一个是西文时按前缀匹配（"desig" 找到 "design"）；单个汉字本身就是完整的词
  return `"${tokens.join(' ')}"${IS_CJK.test(last) ? '' : '*'}`
}

/** 一个字段的值 → 要索引的文字（列表用顿号连起来）。 */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = Array.isArray(value) ? value.map(String).join('、') : String(value)
  return s.trim() ? s : undefined
}

const searchable = (def: BlockKind) => Object.entries(def.fields).filter(([, f]) => f.search)

export class SearchIndex {
  private readonly stmt

  constructor(
    private readonly db: Database.Database,
    private readonly reg: Registry
  ) {
    this.stmt = {
      docs: db.prepare('SELECT id FROM derived.search_doc WHERE entity_id = ? AND kind = ?').pluck(),
      delText: db.prepare('DELETE FROM derived.search WHERE rowid = ?'),
      delDocs: db.prepare('DELETE FROM derived.search_doc WHERE entity_id = ? AND kind = ?'),
      entityDocs: db.prepare('SELECT id FROM derived.search_doc WHERE entity_id = ?').pluck(),
      delEntityDocs: db.prepare('DELETE FROM derived.search_doc WHERE entity_id = ?'),
      addDoc: db.prepare('INSERT INTO derived.search_doc (entity_id, kind, field) VALUES (?, ?, ?)'),
      addText: db.prepare('INSERT INTO derived.search (rowid, body) VALUES (?, ?)'),
      meta: db.prepare("SELECT value FROM derived.meta WHERE key = 'search'").pluck(),
      setMeta: db.prepare("INSERT INTO derived.meta (key, value) VALUES ('search', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    }
  }

  /** 一个数据块写入后：重写它在索引里的几行。在存储的写入事务里调用。 */
  write(id: string, def: BlockKind, data: BlockData): void {
    this.remove(id, def.id)
    for (const [field] of searchable(def)) {
      const text = textOf(data[field])
      if (!text) continue
      const row = Number(this.stmt.addDoc.run(id, def.id, field).lastInsertRowid)
      this.stmt.addText.run(row, spaced(text))
    }
  }

  /** 一个身份在索引里的全部行（彻底删除时）。 */
  removeEntity(id: string): void {
    for (const r of this.stmt.entityDocs.all(id) as number[]) this.stmt.delText.run(r)
    this.stmt.delEntityDocs.run(id)
  }

  remove(id: string, kind: string): void {
    const rows = this.stmt.docs.all(id, kind) as number[]
    if (!rows.length) return
    for (const r of rows) this.stmt.delText.run(r)
    this.stmt.delDocs.run(id, kind)
  }

  /**
   * 打开库时：可搜索的字段（插件定义的、停用的插件留下的）或切字方式变了，或者 derived.db 是新的，重建索引。
   * 用户模板的字段在运行中会变，不算进来：改模板时数据随之重写，索引跟着重写。
   */
  ensure(): boolean {
    const kinds = this.reg.allKinds().filter((k) => k.template === undefined)
    const signature = JSON.stringify([VERSION, ...kinds.flatMap((k) => searchable(k).map(([f]) => `${k.id}.${f}`)).sort()])
    if (this.stmt.meta.get() === signature) return false
    this.rebuild()
    this.stmt.setMeta.run(signature)
    return true
  }

  /** 按现在的定义把全部数据块重新写进索引。 */
  rebuild(): void {
    const kinds = this.reg.allKinds().filter((k) => searchable(k).length)
    this.db.transaction(() => {
      this.db.exec('DELETE FROM derived.search; DELETE FROM derived.search_doc;')
      for (const def of kinds) {
        // 先读出来再写：同一个连接上边读边写不行
        const rows = this.db
          .prepare(`SELECT entity_id, data FROM ${this.reg.schemaOf(def.id)}.block WHERE kind = ?`)
          .raw(true)
          .all(def.id) as [string, string][]
        for (const [id, data] of rows) this.write(id, def, JSON.parse(data) as BlockData)
      }
    })()
  }
}

/**
 * 查询里的全文条件 → SQL 片段。每个词各成一个条件（都要有），可以落在这个身份的不同字段上：
 * "留白 海报"可以是笔记里写了留白、标签是海报。
 */
export function textConditions(reg: Registry, searches: TextSearch[]): { sql: string[]; params: string[] } {
  const sql: string[] = []
  const params: string[] = []
  for (const search of searches) {
    const def = search.kind ? reg.kind(search.kind) : undefined
    // 模板/字段移除或改成非文字后，旧范围没有结果，不能悄悄退回全部内容。
    if ((search.kind && (!def || !searchable(def).length)) || (search.field && !def?.fields[search.field]?.search)) {
      sql.push('0')
      continue
    }
    for (const term of searchTerms(search.text)) {
      const phrase = phraseOf(term)
      if (!phrase) continue
      const scope = [search.kind ? 'AND d.kind = ?' : '', search.field ? 'AND d.field = ?' : ''].join(' ')
      sql.push(`e.id IN (SELECT d.entity_id FROM derived.search s JOIN derived.search_doc d ON d.id = s.rowid WHERE s.body MATCH ? ${scope})`)
      params.push(phrase)
      if (search.kind) params.push(search.kind)
      if (search.field) params.push(search.field)
    }
  }
  return { sql, params }
}

/** 摘要的长度：命中的词前面留一些，后面多留一些。 */
const BEFORE = 16
const AFTER = 44

/**
 * 命中的那一句：在可搜索的字段里找第一个出现的词，取它前后一段，标出所有词的位置。
 * 长文本（正文、笔记）优先，然后是单行文字，最后是列表（标签）。找不到（例如只是变音符号不同）时没有摘要。
 */
export function snippetOf(reg: Registry, blocks: Blocks, input: string | TextSearch[]): Snippet | undefined {
  const searches = typeof input === 'string' ? [{ text: input }] : input
  const fields: { kind: string; field: string; label: string; text: string; terms: string[]; weight: number; order: number }[] = []
  for (const [kind, block] of Object.entries(blocks)) {
    const def = reg.kind(kind)
    if (!def) continue
    const list = searchable(def)
    for (const [name, f] of list) {
      const matching = searches.filter((s) => searchesField(s, kind, name) && searchTerms(s.text).length)
      if (!matching.length) continue
      const terms = matching.flatMap((s) => searchTerms(s.text)).map((t) => t.toLowerCase())
      const raw = textOf(block.data[name])
      if (!raw) continue
      const text = f.format === 'markdown' ? plainOfMarkdown(raw) : raw
      const label = list.length === 1 && def.template === undefined ? def.title : `${def.title} · ${f.title}`
      // 叠加搜索时先说明最新条件命中何处，再按长文本优先排列。
      fields.push({ kind, field: name, label, text, terms, order: searches.lastIndexOf(matching[matching.length - 1]), weight: f.list ? 2 : f.type === 'longtext' ? 0 : 1 })
    }
  }
  fields.sort((a, b) => b.order - a.order || a.weight - b.weight)
  for (const f of fields) {
    const lower = f.text.toLowerCase()
    const hits = f.terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)
    if (!hits.length) continue
    const at = Math.min(...hits)
    const start = Math.max(0, at - BEFORE)
    const end = Math.min(f.text.length, at + AFTER)
    const text = (start > 0 ? '…' : '') + f.text.slice(start, end).replace(/\s+/g, ' ') + (end < f.text.length ? '…' : '')
    return { kind: f.kind, field: f.field, label: f.label, text, marks: marksIn(text, f.terms) }
  }
  return undefined
}
