// 拖出的物理路径按仓库记录认回素材，不从 files/<目录名> 推导素材 ID。
import type Database from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { LibraryFiles } from '../storage/library-files'
import { findSpaceReferences } from '../storage/space-bindings'
import { DirectorySpaces } from '../storage/directory-spaces'
import { parseDirectoryReference } from '../storage/directory-reference'
import { fileReference } from '../shared/file-location'

export function identifyFiles(db: Database.Database, files: LibraryFiles, paths: string[]): (string | null)[] {
  if (!Array.isArray(paths) || paths.length > 1000 || paths.some(path => typeof path !== 'string')) throw new Error('文件路径列表无效')
  if (!paths.length) return []
  const normalize = (path: string) => {
    try { path = realpathSync(path) } catch { path = resolve(path) }
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  const physical = paths.map(path => { try { return realpathSync(path) } catch { return resolve(path) } })
  const requested = physical.map(normalize), wanted = new Set(requested), found = new Map<string, string>()
  const root = normalize(files.root)
  const refs = physical.flatMap(path => { try {
    const ref = fileReference(relative(root, path))
    return ref.startsWith('cache/') ? [ref.toLowerCase()] : []
  } catch { return [] } })
  // 名称不是身份；引用中的显示文件名即使变化，仍按空间、文件和版本匹配。
  const prefixLength = 'spaces/v2/'.length + 3 * 37
  const prefixes = findSpaceReferences(files.root, db, physical).map(ref => ref.slice(0, prefixLength))
  const home = process.env.HUOYE_DIRECTORY_CATALOG
  if (home && db.prepare('SELECT 1 FROM space_adoptions LIMIT 1').get()) {
    const id = db.prepare("SELECT value FROM meta WHERE key='library_id'").pluck().get() as string
    const candidates = new DirectorySpaces(home).identify({ id, root: files.root }, physical)
    const lookup = db.prepare(`SELECT b.entity_id,json_extract(b.data,'$.path') AS reference FROM space_adoptions a
      JOIN entity e ON e.id=a.entity_id AND e.deleted_at IS NULL JOIN block b ON b.entity_id=e.id AND b.kind='file'
      WHERE a.space_id=? AND a.file_id=?`)
    for (const c of candidates) {
      const row = lookup.get(c.spaceId, c.fileId) as { entity_id: string; reference: string } | undefined
      const ref = row && parseDirectoryReference(row.reference)
      if (!row || ref?.spaceId !== c.spaceId || ref.fileId !== c.fileId) continue
      // 已收录但过期的文件不能落入“作为新文件导入”分支。
      const path = normalize(files.readable(row.reference))
      if (wanted.has(path)) {
        if (found.has(path) && found.get(path) !== row.entity_id) throw Error('该文件对应多个素材，请在库内选择要整理的素材')
        found.set(path, row.entity_id)
      }
    }
  }
  if (!refs.length && !prefixes.length) return requested.map(path => found.get(path) ?? null)
  const rows = db.prepare(`SELECT b.entity_id, b.data FROM main.block b JOIN main.entity e ON e.id=b.entity_id
    WHERE b.kind='file' AND e.deleted_at IS NULL AND
    (lower(replace(json_extract(b.data, '$.path'), char(92), '/')) IN (SELECT value FROM json_each(?))
      OR substr(replace(json_extract(b.data, '$.path'), char(92), '/'),1,?) IN (SELECT value FROM json_each(?)))`).iterate(JSON.stringify(refs), prefixLength, JSON.stringify(prefixes)) as Iterable<{ entity_id: string; data: string }>
  for (const row of rows) {
    try {
      const path = normalize(files.readable(String(JSON.parse(row.data).path)))
      if (wanted.has(path) && !found.has(path)) found.set(path, row.entity_id)
      if (found.size === wanted.size) break
    } catch { /* 不可用引用不能被回拖识别为可用素材 */ }
  }
  return requested.map(path => found.get(path) ?? null)
}
