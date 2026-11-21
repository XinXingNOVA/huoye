import Database from 'better-sqlite3'
import { extname, join } from 'node:path'
import type { Library } from './library'
import { sourceFile } from '../storage/source-file'
import { directoryCatalogHome } from '../storage/directory-reference'
import { hasDirectoryAccess } from '../storage/directory-members'
import { directoryPageSchema, type DirectoryFileQuery, type DirectoryFilePage, type DirectoryFileRow } from '../shared/source-automation'

// 观察清单和收录状态来自不同数据库。一次只读连接为一页取得一致快照，游标按文件身份接续。
export function directoryFilePage(lib: Library, raw: DirectoryFileQuery, ids?: string[]): DirectoryFilePage {
  const query = directoryPageSchema.parse(raw)
  let db: Database.Database
  try { db = new Database(join(directoryCatalogHome(), query.spaceId, 'catalog.sqlite'), { readonly: true, fileMustExist: true }) }
  catch { throw new Error('[SPACE_NOT_LINKED] 此库没有可读取的原地目录登记') }
  try {
    db.pragma('query_only=ON')
    db.prepare('ATTACH DATABASE ? AS warehouse').run(join(lib.root, 'library.db'))
    db.function('suffix', (name: string) => extname(name).slice(1).toLowerCase())
    db.function('adopted_hash', (path: string | null, id: string) => {
      const ref = sourceFile(path)
      return ref?.spaceId === query.spaceId && ref.fileId === id && 'hash' in ref ? ref.hash : null
    })
    return db.transaction(() => {
      if (!hasDirectoryAccess(db, lib) || !db.prepare('SELECT 1 FROM source WHERE id=?').get(query.spaceId))
        throw new Error('[SPACE_NOT_LINKED] 请先关联此原地目录')
      const parent = query.folderId ?? 'root'
      const folder = db.prepare('SELECT checkedAt FROM entries WHERE id=? AND folder=1').get(parent) as { checkedAt: number | null } | undefined
      // 仅可读已收录素材时不通过目录 ID 暴露其他目录是否存在。
      const filter = query.collectFilter ?? 'all'
      if (!folder && (filter === 'all' || filter === 'uncollected')) throw new Error('[SPACE_CHANGED] 文件夹已变化，请重新浏览')
      const rows = db.prepare(`WITH candidates AS (
        SELECT e.id,e.name,e.path,e.size,e.stamp,e.folder, a.entity_id, n.deleted_at,
          adopted_hash(json_extract(b.data,'$.path'),e.id) AS adopted,
          CASE WHEN v.stamp=e.stamp THEN v.hash END AS verified
        FROM entries e LEFT JOIN verified_files v ON v.id=e.id
        LEFT JOIN warehouse.space_adoptions a ON a.space_id=@space AND a.file_id=e.id
        LEFT JOIN warehouse.entity n ON n.id=a.entity_id LEFT JOIN warehouse.block b ON b.entity_id=n.id AND b.kind='file'
        WHERE ${ids ? 'e.id IN (SELECT value FROM json_each(@ids)) AND' : ''} e.id!='root' AND e.id>@after AND (@parent IS NULL OR e.parent=@parent)
          AND (e.folder=0 OR @folders=1)
          AND (@suffixes IS NULL OR suffix(e.name) IN (SELECT value FROM json_each(@suffixes)))
          AND instr(lower(e.name),lower(@search))>0)
        SELECT id,name,path,size,stamp,folder, CASE WHEN adopted IS NOT NULL THEN entity_id END AS collected,
          CASE WHEN adopted IS NULL THEN 'uncollected' WHEN deleted_at IS NULL THEN 'collected' ELSE 'trashed' END AS collectionState,
          coalesce(adopted<>verified AND deleted_at IS NULL,0) AS hasUpdate
        FROM candidates WHERE @filter='all' OR collectionState=@filter OR (@filter='outdated' AND hasUpdate)
        ORDER BY id LIMIT @limit`).all({ ...(ids && { ids: JSON.stringify(ids) }), space: query.spaceId, after: query.afterId ?? '', parent: query.folderId === undefined ? null : parent,
          folders: Number(query.folderId !== undefined && filter === 'all' && !query.suffixes?.length), search: query.search ?? '',
          suffixes: query.suffixes?.length ? JSON.stringify(query.suffixes.map(s => s.toLowerCase())) : null, filter, limit: query.limit + 1
        }) as (Omit<DirectoryFileRow,'folder'|'hasUpdate'|'collected'> & {folder: number; hasUpdate: number; collected: string | null})[]
      const items = rows.slice(0, query.limit).map(({ folder, hasUpdate, collected, ...r }) => ({ ...r, folder: !!folder, hasUpdate: !!hasUpdate, ...(collected && { collected }) }))
      return { items, checkedAt: filter === 'all' || filter === 'uncollected' ? folder?.checkedAt ?? null : null,
        ...(rows.length > query.limit && { nextAfterId: items[items.length-1].id }) }
    })()
  } finally { db.close() }
}
