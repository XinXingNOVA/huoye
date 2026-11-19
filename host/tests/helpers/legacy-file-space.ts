// 冻结旧格式数据库，只用于拒绝打开／只读检查；绝不通过生产类初始化。
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SpaceMode } from '../../src/shared/file-spaces'

export function createLegacySpace(root: string, mode: SpaceMode) {
  mkdirSync(root); mkdirSync(join(root, 'files'))
  const id = randomUUID()
  const db = new Database(join(root, '.file-space.db'))
  try {
    db.exec("CREATE TABLE space (id TEXT PRIMARY KEY, owner TEXT NOT NULL, version INTEGER NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL)")
    db.prepare('INSERT INTO space VALUES (?,?,2,?,?,1)').run(id, '', mode, basename(root))
  } finally { db.close() }
  return { id, root, mode, name: basename(root) }
}
