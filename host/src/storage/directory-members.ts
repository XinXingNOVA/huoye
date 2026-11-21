import type Database from 'better-sqlite3'
import { lstatSync } from 'node:fs'

export interface DirectoryMember { id: string; root: string }

function locationKey(root: string) {
  const st = lstatSync(root, { bigint: true, throwIfNoEntry: false })
  return st?.isDirectory() && st.ino && st.birthtimeNs > 0n ? [st.dev, st.ino, st.birthtimeNs].join(':') : null
}

export function hasDirectoryAccess(db: Database.Database, member: DirectoryMember) {
  // SELECT * 也兼容尚未迁移的只读登记簿。
  const row = db.prepare('SELECT * FROM members WHERE id=? AND root=?').get(member.id, member.root) as { locationKey?: string | null } | undefined
  return !!row && (!row.locationKey || row.locationKey === locationKey(member.root))
}

export function grantDirectoryAccess(db: Database.Database, member: DirectoryMember) {
  db.prepare(`INSERT INTO members(id,root,locationKey) VALUES (?,?,?)
    ON CONFLICT(id,root) DO UPDATE SET locationKey=excluded.locationKey`).run(member.id, member.root, locationKey(member.root))
}

/** 同一物理仓库目录移动后才自动接续；同 ID 的复制品需用户重新选择来源。 */
export function resumeDirectoryMember(db: Database.Database, member: DirectoryMember) {
  const rows = db.prepare('SELECT root,locationKey FROM members WHERE id=?').all(member.id) as { root: string; locationKey: string | null }[]
  if (!rows.length) return
  const key = locationKey(member.root)
  if (!key) return
  const current = rows.find(row => row.root === member.root)
  if (current) {
    if (!current.locationKey) db.prepare('UPDATE members SET locationKey=? WHERE id=? AND root=? AND locationKey IS NULL').run(key, member.id, member.root)
    return
  }
  const matches = rows.filter(row => row.locationKey === key)
  if (matches.length !== 1 || lstatSync(matches[0].root, { throwIfNoEntry: false })) return
  db.prepare('UPDATE members SET root=? WHERE id=? AND root=? AND locationKey=?').run(member.root, member.id, matches[0].root, key)
}
