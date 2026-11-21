import { missingCheckSchema } from './missing-check'
import { ignoredDirectoryEntry } from './directory-policy'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'

export type ObservedChild = { name: string; folder: number; size: number; stamp: string; diskKey: string | null }
export type CatalogEntry = { id: string; parent: string | null; path: string; checkedAt: number | null } & ObservedChild

// 只有单一硬链接、可靠文件号和创建时间才能作为跨路径接续的依据。
export function moveKey(st: BigIntStats) {
  if (!st.isFile() || st.nlink !== 1n || !st.ino || st.birthtimeNs <= 0n) return null
  return [st.dev, st.ino, st.birthtimeNs].join(':')
}

export function prepareDirectoryCatalog(db: Database.Database) {
  const version = () => Number(db.pragma('user_version', { simple: true }))
  if (version() === 4) return
  db.transaction(() => {
    const current = version()
    if (current === 4) return
    if (![0, 1, 2, 3].includes(current)) throw new Error('原地目录登记版本不受支持')
    if (current === 0) db.exec(`
      ALTER TABLE entries ADD COLUMN diskKey TEXT;
      CREATE INDEX entry_move_key ON entries(diskKey) WHERE diskKey IS NOT NULL;
      CREATE TABLE missing_files(id TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, diskKey TEXT, missingAt INTEGER NOT NULL);
      CREATE INDEX missing_move_key ON missing_files(diskKey) WHERE diskKey IS NOT NULL;
      CREATE INDEX missing_page ON missing_files(missingAt DESC,id);
      CREATE TABLE verified_files(id TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TRIGGER keep_missing_file BEFORE DELETE ON entries WHEN OLD.folder=0 BEGIN
        INSERT INTO missing_files VALUES (OLD.id,OLD.path,OLD.size,OLD.diskKey,unixepoch())
          ON CONFLICT(id) DO UPDATE SET path=excluded.path,size=excluded.size,diskKey=excluded.diskKey,missingAt=excluded.missingAt;
      END;

    `)
    if (current < 2) {
      db.function('excluded_path', (path, folder) => {
        const parts = String(path).split(sep)
        return Number(parts.some((name, i) => ignoredDirectoryEntry(name, !!folder || i < parts.length - 1)))
      })
      db.exec(`
        DELETE FROM entries WHERE excluded_path(path,folder);
        DELETE FROM missing_files WHERE excluded_path(path,0);
        DELETE FROM verified_files WHERE id NOT IN (SELECT id FROM entries UNION ALL SELECT id FROM missing_files);
        UPDATE missing_files SET diskKey=NULL WHERE diskKey IN (SELECT diskKey FROM entries WHERE diskKey IS NOT NULL);
        ALTER TABLE verified_files ADD COLUMN stamp TEXT;
      `)
    }
    if (current < 3) db.exec(`ALTER TABLE members ADD COLUMN locationKey TEXT;
      CREATE TABLE verification_issues(id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, stamp TEXT NOT NULL, reason TEXT NOT NULL);
    `)
    db.exec(missingCheckSchema)
    db.pragma('user_version=4')
  }).immediate()
}

type Candidate = { id: string; path: string }
const candidateSql = 'SELECT id,path FROM entries WHERE diskKey=? UNION ALL SELECT id,path FROM missing_files WHERE diskKey=? LIMIT 2'

export function otherLocations(db: Database.Database, parent: CatalogEntry, found: ObservedChild[]) {
  const prior = new Map((db.prepare('SELECT name,diskKey FROM entries WHERE parent=? AND folder=0').all(parent.id) as ObservedChild[]).map(row => [row.name, row.diskKey]))
  const query = db.prepare(candidateSql)
  const paths = new Map<string, string>()
  for (const item of found) {
    if (!item.diskKey || prior.get(item.name) === item.diskKey) continue
    const matches = query.all(item.diskKey, item.diskKey) as Candidate[]
    if (matches.length === 1 && dirname(matches[0].path) !== (parent.path || '.')) paths.set(matches[0].path, item.diskKey)
  }
  return paths
}

export async function absentLocations(root: string, paths: Map<string, string>, signal?: AbortSignal) {
  const absent = new Set<string>()
  for (const [path, previousKey] of paths) {
    signal?.throwIfAborted()
    if (isAbsolute(path) || path.split(sep).includes('..')) continue
    try {
      const parent = join(root, dirname(path))
      if (await realpath(parent) !== parent) continue
      const current = await lstat(join(root, path), { bigint: true })
      if (!current.isFile() || [current.dev, current.ino, current.birthtimeNs].join(':') !== previousKey) absent.add(path)
    }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') absent.add(path)
    }
  }
  return absent
}

/** 完整枚举后才在事务中核对。即使父目录消失，文件的缺失记录也能独立接续。 */
export function reconcileDirectory(db: Database.Database, parent: CatalogEntry, found: ObservedChild[], absent: Set<string>) {
  const old = new Map((db.prepare('SELECT * FROM entries WHERE parent=?').all(parent.id) as CatalogEntry[]).map(row => [row.name, row]))
  const observed = new Map(found.map(row => [row.name, row]))
  const remove = db.prepare('DELETE FROM entries WHERE id=?')
  const forgetMissing = db.prepare('DELETE FROM missing_files WHERE id=?')
  const add = db.prepare('INSERT INTO entries(id,parent,name,path,folder,size,stamp,diskKey) VALUES (?,?,?,?,?,?,?,?)')
  const update = db.prepare('UPDATE entries SET size=?,stamp=?,diskKey=? WHERE id=?')
  const locate = db.prepare(candidateSql)
  const claimed = new Set<string>()
  const moved = new Map<string, string>()

  // 先用完整的旧快照认领移动身份，才决定哪些原路径可以沿用。互换名字和改名顶替与遍历顺序无关。
  for (const item of found) {
    if (!item.diskKey || old.get(item.name)?.diskKey === item.diskKey) continue
    const candidates = locate.all(item.diskKey, item.diskKey) as Candidate[]
    if (candidates.length !== 1) continue
    const prior = candidates[0]
    const local = dirname(prior.path) === (parent.path || '.')
    if (local || absent.has(prior.path)) {
      moved.set(item.name, prior.id)
      claimed.add(prior.id)
    }
  }
  const retained = new Set<string>()
  for (const previous of old.values()) {
    const item = observed.get(previous.name)
    if (item && item.folder === previous.folder && !claimed.has(previous.id) && !moved.has(item.name)
      && (!item.folder || previous.stamp === item.stamp)) {
      retained.add(item.name)
      if (previous.stamp !== item.stamp || previous.diskKey !== item.diskKey) update.run(item.size, item.stamp, item.diskKey, previous.id)
    } else remove.run(previous.id)
  }
  for (const item of found) {
    if (retained.has(item.name)) continue
    const id = moved.get(item.name) ?? randomUUID()
    if (moved.has(item.name)) {
      remove.run(id)
      forgetMissing.run(id)
    }
    add.run(id, parent.id, item.name, join(parent.path, item.name), item.folder, item.size, item.stamp, item.diskKey)
  }
  db.prepare('UPDATE entries SET checkedAt=? WHERE id=?').run(Date.now(), parent.id)
}
