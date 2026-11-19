import type Database from 'better-sqlite3'

/** 新建和已知 v4 增量共用定义；不重建丢失的原始版本／回执表。 */
const addedTables: Record<string, string> = {
  space_disk_locations: 'CREATE TABLE space_disk_locations (file_id TEXT NOT NULL, path TEXT PRIMARY KEY)',
  space_disk_observations: 'CREATE TABLE space_disk_observations (version_id TEXT PRIMARY KEY, observation TEXT NOT NULL, checked_at INTEGER NOT NULL, replacement TEXT)',
  space_disk_operations: 'CREATE TABLE space_disk_operations (request_id TEXT PRIMARY KEY, signature TEXT NOT NULL, plan TEXT NOT NULL, commit_input TEXT, result TEXT)',
  version_import_batches: 'CREATE TABLE version_import_batches (key TEXT PRIMARY KEY, token TEXT NOT NULL)',
  history_restorations: 'CREATE TABLE history_restorations (requestId TEXT PRIMARY KEY, signature TEXT NOT NULL, commitInput TEXT)',
  space_file_records: 'CREATE TABLE space_file_records (file_id TEXT PRIMARY KEY, archived_at INTEGER, cleaned_at INTEGER, disposal_id TEXT, busy_request TEXT)',
  space_disposals: 'CREATE TABLE space_disposals (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, bundle TEXT NOT NULL, manifest TEXT NOT NULL, stage TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT)',
  space_disposal_commands: "CREATE TABLE space_disposal_commands (request_id TEXT PRIMARY KEY, signature TEXT NOT NULL, input TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]', finished INTEGER NOT NULL DEFAULT 0, pid INTEGER NOT NULL)"
}
const baseTables = ['space', 'members', 'files', 'recycled_files', 'file_versions', 'version_members', 'file_heads', 'version_drafts', 'version_receipts', 'space_changes']
const addedColumns: Record<string, Record<string, string>> = {
  version_members: { revise: 'INTEGER NOT NULL DEFAULT 0', recycle: 'INTEGER NOT NULL DEFAULT 0' },
  // 早期草稿属于应用，不可在升级后被仓库调用方借用。
  version_drafts: { actor: "TEXT NOT NULL DEFAULT 'application'" }
}
export const versionedSpaceSchema = `
  CREATE TABLE space (id TEXT PRIMARY KEY, owner TEXT NOT NULL, version INTEGER NOT NULL,
    mode TEXT NOT NULL DEFAULT 'private', name TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE members (library_id TEXT PRIMARY KEY, root TEXT NOT NULL, token TEXT NOT NULL);
  CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, hash TEXT NOT NULL,
    size INTEGER NOT NULL, mtime REAL NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE INDEX files_hash_size ON files(hash,size) WHERE state='available';
  CREATE TABLE recycled_files (file_id TEXT PRIMARY KEY, recycled_at INTEGER NOT NULL);
  CREATE TABLE file_versions (id TEXT PRIMARY KEY, fileId TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL,
    size INTEGER NOT NULL, createdAt INTEGER NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, mtime REAL NOT NULL,
    UNIQUE(fileId,ordinal));
  CREATE TABLE version_members (library_id TEXT PRIMARY KEY, token TEXT NOT NULL,
    revise INTEGER NOT NULL DEFAULT 0, recycle INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE file_heads (fileId TEXT PRIMARY KEY, contentVersion TEXT NOT NULL);
  CREATE TABLE version_drafts (id TEXT PRIMARY KEY, fileId TEXT NOT NULL, baseRevision INTEGER, contentVersion TEXT NOT NULL,
    name TEXT NOT NULL, state TEXT NOT NULL, hash TEXT, size INTEGER, error TEXT, requestId TEXT NOT NULL UNIQUE,
    signature TEXT NOT NULL, path TEXT NOT NULL UNIQUE, sourceSize INTEGER NOT NULL, sourceMtime REAL NOT NULL, pid INTEGER NOT NULL, actor TEXT NOT NULL);
  CREATE TABLE version_receipts (requestId TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL);
  CREATE TABLE space_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, fileId TEXT NOT NULL, contentVersion TEXT NOT NULL,
    revision INTEGER NOT NULL, type TEXT NOT NULL, createdAt INTEGER NOT NULL);
${Object.values(addedTables).join(';\n')};
`

/** 只识别已知增量，不将未知／损坏结构当作新空间初始化。 */
function pendingSchema(db: Database.Database): string[] {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all() as string[])
  const missing = baseTables.filter(table => !tables.has(table))
  if (missing.length) throw new Error(`[FILE_SPACE_SCHEMA_INCOMPLETE] 文件空间缺少基础表：${missing.join('、')}；请保留目录并检查备份`)
  const changes: string[] = []
  for (const [table, fields] of Object.entries(addedColumns)) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
    for (const [name, definition] of Object.entries(fields)) if (!columns.has(name)) changes.push(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
  for (const [name, sql] of Object.entries(addedTables)) if (!tables.has(name)) changes.push(sql)
  return changes
}

/** 仅 FileSpace 的受控打开阶段调用；已就绪时不取得写锁。 */
export function prepareSpaceSchema(db: Database.Database): void {
  if (!pendingSchema(db).length) return
  db.transaction(() => {
    // 多仓库可同时打开共享空间，取得写锁后重新识别待补结构。
    for (const sql of pendingSchema(db)) db.exec(sql)
  }).immediate()
}

/** 主进程只读适配不升级结构，也不构造可写 FileSpace。 */
export function assertSpaceSchemaReady(db: Database.Database): void {
  if (pendingSchema(db).length) throw new Error('[FILE_SPACE_SCHEMA_NOT_READY] 文件空间结构尚未准备好，请先在应用中打开关联仓库或文件空间')
}
