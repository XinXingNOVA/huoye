// 查询：有 / 没有某种数据块 + 字段条件 + 排序，全部落在结构索引上。

import type Database from 'better-sqlite3'
import { legacyPlaybackKind, playbackQueryCte } from './playback-handoff'
import { searchesOf, type FacetItem, type FacetOptions, type Query, type QueryResult } from '../shared/query'
import { inventoryLimits, type FacetBucket } from '../shared/automation'
import type { Registry } from './registry'
import { textConditions } from './search'

function querySql(reg: Registry, q: Query, mode: 'rows' | 'count' | 'ids' = 'rows', paged = false): { sql: string; params: unknown[] } {
  let legacy = false
  const source = (kind: string, table: 'block' | 'field_index') => {
    if (kind !== 'playback') return `${reg.schemaOf(kind)}.${table}`
    legacy = true
    return table === 'block' ? 'legacy_playback_block' : 'legacy_playback_index'
  }
  const definition = (id: string) => id === 'playback' ? legacyPlaybackKind : reg.kind(id)
  const where: string[] = []
  const params: unknown[] = []
  const joins: string[] = []

  const scope = q.scope ?? 'content'
  const searches = searchesOf(q)
  // 浏览全库时沿 (kind, entity_id) 索引取身份集合。分页和已有候选范围继续按身份短路。
  const scanByKind = !paged && scope !== 'trash' && !q.ids && !q.where?.length && !searches.length
  const wholeScope = scanByKind && !q.has?.length && !q.lacks?.length
  const hasKind = (schema: string, kinds: string[]) => {
    params.push(JSON.stringify(kinds))
    const match = 'kind IN (SELECT value FROM json_each(?))'
    return wholeScope ? `e.id IN (SELECT entity_id FROM ${schema}.block WHERE ${match})`
      : `EXISTS (SELECT 1 FROM ${schema}.block WHERE entity_id=e.id AND ${match})`
  }
  if (scope === 'trash') {
    where.push('e.deleted_at IS NOT NULL')
  } else {
    where.push('e.deleted_at IS NULL')
    if (scope === 'content') {
      const bySchema = groupBySchema(
        reg,
        reg.contentKinds().map((k) => k.id)
      )
      const parts = Object.entries(bySchema).map(([schema, kinds]) => hasKind(schema, kinds))
      where.push(parts.length ? `(${parts.join(' OR ')})` : '0')
    }
  }

  const role = q.role ?? (scope === 'all' ? undefined : 'browse')
  if (role) {
    const kinds = reg.allKinds().filter(k => {
      if (role === 'container') return k.container
      if (role === 'management') return k.management
      return k.management || k.ownedBy || (role === 'material' && k.container)
    })
    const exclude = role === 'material' || role === 'browse'
    const membership = hasKind('main', kinds.map(k => k.id))
    where.push(exclude ? `NOT (${membership})` : membership)
  }

  if (q.ids) {
    where.push('e.id IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(q.ids))
  }

  const text = textConditions(reg, searches)
  where.push(...text.sql)
  params.push(...text.params)

  // 不存在的数据块（模板被撤销、插件被卸载）：什么也匹配不到，而不是让查询出错
  for (const kind of q.has ?? []) {
    if (!definition(kind)) {
      where.push('0')
      continue
    }
    const table = source(kind, 'block')
    where.push(scanByKind ? `e.id IN (SELECT entity_id FROM ${table} WHERE kind=?)`
      : `EXISTS (SELECT 1 FROM ${table} b WHERE b.entity_id=e.id AND b.kind=?)`)
    params.push(kind)
  }
  for (const kind of q.lacks ?? []) {
    if (!definition(kind)) continue
    where.push(`NOT EXISTS (SELECT 1 FROM ${source(kind, 'block')} b WHERE b.entity_id = e.id AND b.kind = ?)`)
    params.push(kind)
  }

  // 字段条件写成不相关的 IN 子查询：先沿 (kind, field, 值) 索引取出符合的身份集合，再逐个比对。
  // 写成按身份逐个 EXISTS 时，SQLite 会选中覆盖索引，每个身份都扫一遍整列，规模一大就变成平方级。
  for (const c of q.where ?? []) {
    // 关系定义不可用时明确失败，不能把整条分支悄悄退化为根标签。
    if (c.op === 'subtree') {
      const relation = reg.kind(c.tree.kind)
      if (!relation || relation.dormant) throw new Error('层级关系所属插件未启用：' + c.tree.kind)
      for (const field of [c.tree.key, c.tree.parent]) {
        const f = indexedField(reg, c.tree.kind, field)
        if (f.type !== 'text' || f.list) throw new Error('层级关系需要单值文字索引')
      }
    }
    if (!definition(c.kind)?.fields[c.field]) {
      if (c.op !== 'empty') where.push('0')
      continue
    }
    const f = indexedField(reg, c.kind, c.field)
    const parts = [`SELECT entity_id FROM ${source(c.kind, 'field_index')} WHERE kind = ? AND field = ?`]
    params.push(c.kind, c.field)
    if (c.op === 'empty') {
      where.push(`e.id NOT IN (${parts[0]})`)
      continue
    }
    if (c.op === 'subtree') {
      if (f.type !== 'text') throw new Error('层级条件只适用于文字字段')
      const relationSchema = reg.schemaOf(c.tree.kind)
      parts.push(`AND txt IN (WITH RECURSIVE branch(value) AS (
        SELECT ? UNION
        SELECT child.txt FROM ${relationSchema}.field_index child
        JOIN ${relationSchema}.field_index parent ON parent.entity_id = child.entity_id
        JOIN main.entity node ON node.id = child.entity_id AND node.deleted_at IS NULL
        JOIN branch ON parent.txt = branch.value
        WHERE child.kind = ? AND child.field = ? AND parent.kind = ? AND parent.field = ?
      ) SELECT value FROM branch)`)
      params.push(c.value, c.tree.kind, c.tree.key, c.tree.kind, c.tree.parent)
    } else if (c.op === 'in') {
      const numeric = f.type === 'number' || f.type === 'date' || f.type === 'boolean'
      parts.push(`AND ${numeric ? 'num' : 'txt'} IN (SELECT value FROM json_each(?))`)
      params.push(JSON.stringify(c.values.map(v => typeof v === 'boolean' ? Number(v) : v)))
    } else if (c.op === 'eq') {
      const numeric = f.type === 'number' || f.type === 'date' || f.type === 'boolean'
      parts.push(`AND ${numeric ? 'num' : 'txt'} = ?`)
      params.push(typeof c.value === 'boolean' ? (c.value ? 1 : 0) : c.value)
    } else if (c.op === 'range') {
      if (f.type !== 'number' && f.type !== 'date') throw new Error(`字段 ${c.kind}.${c.field} 不支持数值范围`)
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) throw new Error('范围下限不能大于上限')
      if (c.min !== undefined) {
        parts.push('AND num >= ?')
        params.push(c.min)
      }
      if (c.max !== undefined) {
        parts.push('AND num <= ?')
        params.push(c.max)
      }
    } else throw new Error('不支持的查询条件')
    where.push(`e.id IN (${parts.join(' ')})`)
  }

  const dir = q.dir === 'asc' ? 'ASC' : 'DESC'
  let order = `e.created_at ${dir}, e.id ${dir}`
  if (mode === 'rows' && q.sort && q.sort !== 'created' && definition(q.sort.kind)?.fields[q.sort.field]) {
    const f = indexedField(reg, q.sort.kind, q.sort.field)
    if (f.list) throw new Error(`列表字段 ${q.sort.kind}.${q.sort.field} 不能用于排序`)
    const col = f.type === 'number' || f.type === 'date' || f.type === 'boolean' ? 'num' : 'txt'
    joins.push(
      `LEFT JOIN ${source(q.sort.kind, 'field_index')} fs ${q.sort.kind === 'playback' ? '' : 'INDEXED BY fi_entity'} ON fs.entity_id = e.id AND fs.kind = ? AND fs.field = ?`
    )
    // LEFT JOIN 的参数在 WHERE 之前
    params.unshift(q.sort.kind, q.sort.field)
    order = `fs.${col} IS NULL, fs.${col} ${dir}, ${order}`
  }

  const sql = `${legacy ? playbackQueryCte : ''}
    SELECT ${mode === 'count' ? 'COUNT(*)' : mode === 'ids' ? 'e.id' : 'e.id, cs.aspect'} FROM main.entity e
    ${mode === 'rows' ? 'LEFT JOIN derived.card_summary cs ON cs.entity_id = e.id' : ''}
    ${joins.join('\n')}
    WHERE ${where.join(' AND ')}
    ${mode === 'rows' ? `ORDER BY ${order}` : ''}`
  return { sql, params }
}

export function countQuery(db: Database.Database, reg: Registry, q: Query): number {
  const { sql, params } = querySql(reg, q, 'count')
  return db.prepare(sql).pluck().get(...params) as number
}

export function runQuery(db: Database.Database, reg: Registry, q: Query, page?: { limit: number; offset: number }): QueryResult {
  const { sql, params } = querySql(reg, q, 'rows', !!page)
  if (page) params.push(page.limit, page.offset)
  const rows = db.prepare(sql + (page ? ' LIMIT ? OFFSET ?' : '')).raw(true).all(...params) as [string, number | null][]

  const ids = new Array<string>(rows.length)
  const aspects = new Array<number>(rows.length)
  for (let i = 0; i < rows.length; i++) {
    ids[i] = rows[i][0]
    aspects[i] = rows[i][1] ?? 0
  }
  return { ids, aspects }
}

// 界面与对外盘点共享查询范围、索引列和去重单位。范围先作用于身份，再分桶。
function facetSource(reg: Registry, kind: string, field: string, query: Query) {
  const def = indexedField(reg, kind, field)
  const numeric = def.type === 'number' || def.type === 'date' || def.type === 'boolean'
  const scope = querySql(reg, query, 'ids')
  const index = kind === 'playback' ? `(${playbackQueryCte} SELECT * FROM legacy_playback_index)` : `${reg.schemaOf(kind)}.field_index`
  // 搜索范围先算一次。否则包含多个标签的素材会为每个索引值重新核对身份和内容块。
  const hits = searchesOf(query).length
    ? `WHERE f.kind=? AND f.field=? AND f.entity_id IN (SELECT id FROM matched)`
    : `JOIN matched m ON m.id=f.entity_id WHERE f.kind=? AND f.field=?`
  const sql = `WITH matched AS (${scope.sql}), hits AS (
    SELECT f.entity_id, f.${numeric ? 'num' : 'txt'} AS value FROM ${index} f ${hits}
  )`
  return { sql, params: [...scope.params, kind, field], type: def.type, numeric }
}
const facetCounts = 'COUNT(DISTINCT entity_id) AS count'
const facetOrder = 'FROM hits GROUP BY value ORDER BY count DESC, value ASC'

export function runFacet(db: Database.Database, reg: Registry, kind: string, field: string, options: FacetOptions = {}): FacetItem[] {
  // 省略 query 保留界面既有的全库语义；盘点工具默认使用与 search_items 相同的 content 范围。
  const source = facetSource(reg, kind, field, options.query ?? { scope: 'all', role: 'browse' })
  if (source.numeric) throw new Error(`字段 ${kind}.${field} 不是文本类型，不能做分面`)
  const limit = options.limit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('分面 limit 必须为正整数')
  return db.prepare(source.sql + ` SELECT value, ${facetCounts} ${facetOrder}` + (limit === undefined ? '' : ' LIMIT ?'))
    .all(...source.params, ...(limit === undefined ? [] : [limit])) as FacetItem[]
}

/** 同一条 SQL 同时读取全范围覆盖数和当前桶页，空页也保留总数。 */
export function runFacetPage(db: Database.Database, reg: Registry, kind: string, field: string, query: Query, limit: number, offset: number) {
  if (!reg.kind(kind)?.fields[field]?.index) throw new Error(`[INVALID_INPUT] ${kind}.${field} 不是本库已登记的索引字段，请查 describe_library`)
  const source = facetSource(reg, kind, field, query)
  const large = `typeof(b.value)='text' AND length(CAST(b.value AS BLOB))>${inventoryLimits.facetValueBytes}`
  const rows = db.prepare(`${source.sql}, buckets AS (SELECT value, ${facetCounts}, min(entity_id) sampleId ${facetOrder} LIMIT ? OFFSET ?),
    totals AS (SELECT (SELECT count(*) FROM matched) matchedItems, count(DISTINCT entity_id) withValue FROM hits)
    SELECT totals.*, b.count, b.sampleId, CASE WHEN ${large} THEN NULL ELSE b.value END value,
      CASE WHEN ${large} THEN substr(b.value,1,160) END preview,
      CASE WHEN ${large} THEN length(CAST(b.value AS BLOB)) END bytes
    FROM totals LEFT JOIN buckets b ON 1 ORDER BY b.count DESC, b.value ASC`).all(...source.params, limit + 1, offset) as {
      matchedItems: number; withValue: number; count: number | null; sampleId: string; value: string | number | null; preview: string | null; bytes: number | null
    }[]
  const { matchedItems, withValue } = rows[0]
  const values: FacetBucket[] = []
  for (const row of rows.slice(0, limit)) {
    if (row.count === null) continue
    if (row.bytes !== null) values.push({ value: null, preview: row.preview!, bytes: row.bytes, sampleId: row.sampleId, count: row.count })
    else values.push({ value: source.type === 'boolean' ? Boolean(row.value) : row.value!, count: row.count })
  }
  return { matchedItems, withValue, missingItems: matchedItems - withValue, values, hasMore: rows.length > limit }
}

/** 同一个查询范围批量统计块存在数。未知定义返回 0；不会把 ID 列表传回渲染进程。 */
export function runKindCounts(db: Database.Database, reg: Registry, kinds: string[], query?: Query): Record<string, number> {
  if (!Array.isArray(kinds) || kinds.length > 1000 || kinds.some(k => typeof k !== 'string' || !k || k.length > 200)) throw new Error('块计数需要最多 1000 个有效 kind ID')
  const unique = [...new Set(kinds)], counts = Object.fromEntries(unique.map(k => [k, 0]))
  if (unique.includes('playback')) counts.playback = countQuery(db, reg, { ...(query ?? { scope: 'all', role: 'browse' }), has: [...(query?.has ?? []), 'playback'] })
  const grouped = groupBySchema(reg, unique.filter(k => k !== 'playback' && reg.kind(k)))
  const branches = Object.keys(grouped).map(schema => `SELECT kind, entity_id FROM ${schema}.block WHERE kind IN (SELECT value FROM json_each(?))`)
  if (!branches.length) return counts
  const scope = querySql(reg, query ?? { scope: 'all', role: 'browse' }, 'ids')
  const rows = db.prepare(`WITH matched AS (${scope.sql}), blocks AS (${branches.join(' UNION ALL ')})
    SELECT b.kind, COUNT(DISTINCT b.entity_id) AS count FROM blocks b JOIN matched m ON m.id = b.entity_id GROUP BY b.kind`)
    .all(...scope.params, ...Object.values(grouped).map(ids => JSON.stringify(ids))) as { kind: string; count: number }[]
  for (const row of rows) counts[row.kind] = row.count
  return counts
}

function indexedField(reg: Registry, kind: string, field: string) {
  const f = (kind === 'playback' ? legacyPlaybackKind : reg.requireKind(kind)).fields[field]
  if (!f) throw new Error(`数据块 ${kind} 没有字段 ${field}`)
  if (!f.index) throw new Error(`字段 ${kind}.${field} 没有声明索引，不能用于筛选或排序`)
  return f
}

function groupBySchema(reg: Registry, kinds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const k of kinds) (out[reg.schemaOf(k)] ??= []).push(k)
  return out
}
