import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

export const legacyStorageMessage = '此旧文件格式已停止支持。请保留原目录与备份，使用 Git 标签 file-space-legacy-migration-2026-10-27 的工具在副本中完成迁移，再打开新版仓库。'
export const legacyStorageError = () => new Error(`[LEGACY_STORAGE_UNSUPPORTED] ${legacyStorageMessage}`)
export function assertSpaceFormat(version: number): void {
  if (version === 4) return
  if ([1, 2, 3, 5].includes(version)) throw legacyStorageError()
  throw new Error('[FILE_SPACE_IDENTITY] 不支持的文件空间版本')
}
export function assertNoLegacyRecovery(root: string): void {
  const path = join(root, '.file-recovery')
  if (existsSync(path) && readdirSync(path).length) throw legacyStorageError()
}
/** 只识别，不初始化旧仓库、不续跑旧任务，也不删除失效业务记录。 */
export function assertLibraryFormat(db: Database.Database): void {
  const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!has('meta')) throw legacyStorageError()
  if (has('file_migrations')) {
    for (const row of db.prepare('SELECT data FROM file_migrations').iterate() as Iterable<{ data: string }>) {
      let task: { state?: string; retired?: boolean } | null
      try { task = JSON.parse(row.data) } catch { throw legacyStorageError() }
      if (!task) throw legacyStorageError()
      if (task.state !== 'abandoned' && !(task.state === 'complete' && task.retired)) throw legacyStorageError()
    }
  }
  if (db.prepare("SELECT 1 FROM meta WHERE key='migration_rebuild_pending'").get()) throw legacyStorageError()
  if (!db.prepare("SELECT 1 FROM meta WHERE key IN ('managed_space_root','managed_space_pending')").get()) throw legacyStorageError()
}
