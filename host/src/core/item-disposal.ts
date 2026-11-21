// 仅生成仓库侧的处置快照。不根据任意字符串、普通 link 或派生缓存推断原件。
import { createHash } from 'node:crypto'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { LibrarySpaces } from './file-spaces'
import type { ItemLifecycle } from './item-lifecycle'
import { parseDirectoryReference } from '../storage/directory-reference'
import { parseSpaceReference } from '../storage/space-reference'
import { disposalIds, type ItemDisposalSnapshot } from '../shared/item-disposal'

export function itemDisposalSnapshot(lib: Library, reg: Registry, store: Store, spaces: LibrarySpaces, lifecycle: ItemLifecycle, raw: string[]): ItemDisposalSnapshot {
  const ids = disposalIds.parse(raw).sort(), preview = lifecycle.preview({ action: 'trash', ids })
  const affected = store.withAttached(ids).sort(), references: unknown[] = [], files = new Map<string, { spaceId: string; fileId: string }>()
  const rows = lib.db.prepare('SELECT entity_id,kind,data FROM main.block WHERE entity_id IN (SELECT value FROM json_each(?)) ORDER BY entity_id,kind').all(JSON.stringify(affected)) as { entity_id: string; kind: string; data: string }[]
  for (const row of rows) {
    const def = reg.kind(row.kind)
    if (!def) throw new Error(`[UNKNOWN_KIND] 缺少 ${row.kind} 的定义，无法确认全部原件；可先只移除仓库素材`)
    if (def.rebuildable) continue
    const data = JSON.parse(row.data)
    for (const [field, definition] of Object.entries(def.fields).sort(([a], [b]) => a.localeCompare(b))) {
      if (!definition.file || data[field] == null) continue
      const values = definition.list ? data[field] : [data[field]]
      if (!Array.isArray(values)) throw new Error('[INVALID_FILE_REFERENCE] 原件字段格式无效')
      for (const value of values) {
        if (typeof value !== 'string') throw new Error('[INVALID_FILE_REFERENCE] 原件字段格式无效')
        if (parseDirectoryReference(value)) { references.push([row.entity_id, row.kind, field, value]); continue }
        const ref = parseSpaceReference(value)
        if (!ref?.contentVersion) throw new Error('[INVALID_FILE_REFERENCE] 原件必须是版本空间引用')
        references.push([row.entity_id, row.kind, field, value])
        files.set(ref.spaceId + '/' + ref.fileId, { spaceId: ref.spaceId, fileId: ref.fileId })
      }
    }
  }
  if (files.size > 100) throw new Error('一次最多处置 100 个原件，请减少所选素材')
  const targets = [...files.values()].sort((a, b) => (a.spaceId + a.fileId).localeCompare(b.spaceId + b.fileId))
  const infos = [...new Set(targets.map(f => f.spaceId))].map(id => {
    const space = lib.files.bindings!.open(id), info = space.info()
    return { id, root: info.root, name: info.name, mode: info.mode, members: info.members,
      otherReferences: spaces.referenceIds(id, targets.filter(f => f.spaceId === id).map(f => f.fileId)).filter(id => !affected.includes(id)).length }
  })
  return { ids, affected, identityToken: createHash('sha256').update(JSON.stringify([affected, references])).digest('hex'),
    lifecycle: preview, files: targets, spaces: infos }
}
