import type Database from 'better-sqlite3'
import type { Registry } from './registry'
import type { Library } from './library'
import { confirmedMissing, missingMessage, missingFile } from './confirmed-missing'
import type { Store } from './store'
import { summaryTitle } from '../shared/title'
import { itemSelectionLimit } from '../shared/item-lifecycle'
import { spaceItemPageSize, spaceItemQuery, type SpaceItemPage, type SpaceItemQuery, type SpaceItemRole } from '../shared/space-items'
import { sourceFile } from '../storage/source-file'

function matches(value: unknown, spaceId: string, wanted?: Set<string>): boolean {
  if (value && typeof value === 'object') return Object.values(value).some(v => matches(v, spaceId, wanted))
  const ref = sourceFile(value)
  return !!ref && ref.spaceId === spaceId && (!wanted || wanted.has(ref.fileId))
}

type SourceBlock = { id: string; kind: string; data: string; deleted: number | null }

// 原始块是权威记录，包括休眠插件数据和回收站。只读仓库，不打开来源磁盘。
function* referencedFields(db: Database.Database, spaceId: string) {
  const rows = db.prepare(`SELECT b.entity_id id, b.kind, b.data, e.deleted_at deleted FROM main.block b
    JOIN main.entity e ON e.id=b.entity_id
    WHERE instr(b.data,?) OR instr(b.data,char(92)||'u') ORDER BY b.entity_id`).iterate(spaceId) as Iterable<SourceBlock>
  for (const row of rows) {
    for (const [field, value] of Object.entries(JSON.parse(row.data))) {
      if (matches(value, spaceId)) yield { id: row.id, kind: row.kind, deleted: row.deleted, field, value }
    }
  }
}

export function spaceReferenceIds(db: Database.Database, spaceId: string, fileIds?: string[]) {
  const wanted = fileIds && new Set(fileIds), ids = new Set<string>()
  const rows = db.prepare("SELECT entity_id,data FROM main.block WHERE instr(data,?) OR instr(data,char(92)||'u')")
    .iterate(fileIds?.length === 1 ? fileIds[0] : spaceId) as Iterable<{ entity_id: string; data: string }>
  for (const row of rows) {
    if (!ids.has(row.entity_id) && matches(JSON.parse(row.data), spaceId, wanted)) ids.add(row.entity_id)
  }
  return [...ids]
}

export function listSpaceItems(lib: Library, reg: Registry, store: Store, raw: SpaceItemQuery): SpaceItemPage {
  const { spaceId, group, offset, missingOnly } = spaceItemQuery.parse(raw)
  if (missingOnly && group !== 'primary') throw new Error('缺失筛选只适用于在用主文件')
  const result: SpaceItemPage = { counts: { primary: 0, attachment: 0, unclassified: 0, trashed: 0 }, items: [], offset, selectable: 0, batchIds: [] }
  let missing: ReturnType<typeof confirmedMissing> | undefined
  if (missingOnly) {
    try { missing = confirmedMissing(lib, spaceId) }
    catch (error) { result.missingIssue = missingMessage(error) }
  }
  const titleKinds = reg.allKinds().filter(k => !k.rebuildable && (k.display?.title || k.content || k.standalone)).map(k => k.id)
  let current: { id: string; deleted: number | null; role: SpaceItemRole; missingPath?: string } | undefined
  function finish() {
    if (!current) return
    const { id, role, deleted } = current
    const bucket = deleted === null ? role : 'trashed'
    const position = result.counts[bucket]++
    if (bucket !== group || (missingOnly && !current.missingPath)) return
    const index = missingOnly ? result.selectable : position
    if (role === 'primary') {
      result.selectable++
      if (result.batchIds.length < itemSelectionLimit) result.batchIds.push(id)
    }
    if (index >= offset && index < offset + spaceItemPageSize) {
      const title = summaryTitle(store.blocksOf(id, titleKinds), kind => reg.kind(kind), id)
      result.items.push({ id, role, title, ...(current.missingPath ? { missingPath: current.missingPath } : {}) })
    }
  }
  for (const row of referencedFields(lib.db, spaceId)) {
    if (current?.id !== row.id) {
      finish()
      current = { id: row.id, deleted: row.deleted, role: 'unclassified' }
    }
    if (current.role === 'primary') continue
    const primary = row.kind === 'file' && row.field === 'path' ? sourceFile(row.value) : undefined
    if (primary && primary.spaceId === spaceId) {
      current.role = 'primary'
      if (missing) current.missingPath = missingFile(missing, primary)?.path
      continue
    }
    const field = reg.kind(row.kind)?.fields[row.field]
    if (field?.file && (field.list
      ? Array.isArray(row.value) && row.value.some(v => sourceFile(v)?.spaceId === spaceId)
      : sourceFile(row.value)?.spaceId === spaceId)) current.role = 'attachment'
  }
  finish()
  return result
}
