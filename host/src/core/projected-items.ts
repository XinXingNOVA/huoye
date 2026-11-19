import type Database from 'better-sqlite3'
import { inventoryLimits, type ProjectedItem, type ReadItemsResult } from '../shared/automation'

// 先在 SQLite 筛 kind 和字节数。即使所选块是整部 PDF 正文，也只把大小及版本带进核心进程。
const projectedSql = (['main', 'derived'] as const).map(schema => `
  SELECT entity_id, kind, seq, schema_ver, octet_length(data) bytes,
    CASE WHEN octet_length(data)<=@blockBytes THEN data END data FROM ${schema}.block
    WHERE entity_id IN (SELECT value FROM json_each(@ids)) AND kind IN (SELECT value FROM json_each(@kinds))
`).join(' UNION ALL ')
type Present = Extract<ProjectedItem, { blocks: unknown }>
type BlockRow = { entity_id: string; kind: string; seq: number; schema_ver: number; bytes: number; data: string | null }

export function readProjectedItems(db: Database.Database, ids: string[], kinds: string[], offset: number): ReadItemsResult {
  const entities = db.prepare('SELECT id, deleted_at FROM main.entity WHERE id IN (SELECT value FROM json_each(?))')
  const read = db.prepare(projectedSql), selection = JSON.stringify(kinds)
  const items: ProjectedItem[] = []
  let bytes = 64 // 外层对象、nextOffset 与分隔符
  // 限制一次预取的正文量。显式 ID 分页以输入位置推进，保留重复 ID 和已删除身份的位置。
  const chunkSize = Math.floor(256 / kinds.length)
  for (let start = offset; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize), keys = JSON.stringify(chunk)
    const byId = new Map<string, Present>()
    for (const { id, deleted_at } of entities.all(keys) as { id: string; deleted_at: number | null }[]) {
      byId.set(id, { id, state: deleted_at === null ? 'active' : 'trashed', blocks: Object.create(null) })
    }
    for (const row of read.iterate({ ids: keys, kinds: selection, blockBytes: inventoryLimits.blockBytes }) as Iterable<BlockRow>) {
      const item = byId.get(row.entity_id)
      if (!item) continue
      const version = { seq: row.seq, ver: row.schema_ver }
      item.blocks[row.kind] = row.data === null ? { ...version, omitted: true, bytes: row.bytes } : { ...version, data: JSON.parse(row.data) }
    }
    for (const id of chunk) {
      const item: ProjectedItem = byId.get(id) ?? { id, state: 'missing' }
      const size = Buffer.byteLength(JSON.stringify(item)) + 1
      if (bytes + size > inventoryLimits.pageBytes) {
        if (!items.length) throw new Error('[RESPONSE_TOO_LARGE] 单项投影过大，请减少 kinds')
        return { items, nextOffset: offset + items.length }
      }
      items.push(item)
      bytes += size
    }
  }
  return { items, nextOffset: null }
}
