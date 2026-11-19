import type Database from 'better-sqlite3'
import { libraryTaskSql } from './library-tasks'
import { batchReviewSchemaSql } from './batch-review-schema'

// 表结构，见设计文档 12.3。
// main = library.db（不可重建），derived = derived.db（可重建），两者共有 block / field_index / ref / meta。

export type Schema = 'main' | 'derived'

const shared = (s: Schema): string => `
CREATE TABLE IF NOT EXISTS ${s}.block (
  entity_id  TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  schema_ver INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ${s}.block_kind ON block(kind, entity_id);

CREATE TABLE IF NOT EXISTS ${s}.field_index (
  entity_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  field     TEXT NOT NULL,
  num       REAL,
  txt       TEXT
);
CREATE INDEX IF NOT EXISTS ${s}.fi_txt    ON field_index(kind, field, txt, entity_id);
CREATE INDEX IF NOT EXISTS ${s}.fi_num    ON field_index(kind, field, num, entity_id);
CREATE INDEX IF NOT EXISTS ${s}.fi_entity ON field_index(entity_id, kind, field);

CREATE TABLE IF NOT EXISTS ${s}.ref (
  entity_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  field     TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ref_type  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${s}.ref_target ON ref(target_id, ref_type);
CREATE INDEX IF NOT EXISTS ${s}.ref_entity ON ref(entity_id, kind);

CREATE TABLE IF NOT EXISTS ${s}.meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
INSERT OR IGNORE INTO ${s}.meta (key, value) VALUES ('seq', 0), ('format', 1);
`

const mainOnly = `
CREATE TABLE IF NOT EXISTS main.entity (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS main.entity_created ON entity(created_at, id);

-- data 是写入前的内容，new_data 是写入后的（移除时为空）；op 是这次写入所属的用户操作
CREATE TABLE IF NOT EXISTS main.block_history (
  entity_id TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  data      TEXT,
  at        INTEGER NOT NULL,
  op        INTEGER,
  new_data  TEXT
);
CREATE INDEX IF NOT EXISTS main.history_entity ON block_history(entity_id, kind, seq);

-- 用户操作：一次操作里的数据块写入、身份增删可以整体撤销、重做（设计文档 11.6）
CREATE TABLE IF NOT EXISTS main.operation (
  id      INTEGER PRIMARY KEY,
  session INTEGER NOT NULL,
  label   TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  state   TEXT    NOT NULL,
  context TEXT,
  bytes   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS main.record_history (
  op INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  action TEXT NOT NULL,
  PRIMARY KEY (op, entity_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS main.record_history_entity ON record_history(entity_id);

CREATE TABLE IF NOT EXISTS main.op_entity (
  op             INTEGER NOT NULL,
  entity_id      TEXT    NOT NULL,
  created        INTEGER NOT NULL,
  before_deleted INTEGER,
  after_deleted  INTEGER
);
CREATE INDEX IF NOT EXISTS main.op_entity_op ON op_entity(op);
-- 彻底删除时找出和这些身份有关的操作
CREATE INDEX IF NOT EXISTS main.op_entity_entity ON op_entity(entity_id);

CREATE TABLE IF NOT EXISTS main.kind_def (id TEXT PRIMARY KEY, def TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS main.config (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
-- 外部操作的重试回执：和修改在同一事务提交，撤销后重试也不重新执行。
CREATE TABLE IF NOT EXISTS main.operation_receipt (
  request_id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL
) WITHOUT ROWID;
`

// 仓库侧文件业务的持久状态。建表不恢复任务；服务只使用已准备的结构。
const fileState = `
CREATE TABLE IF NOT EXISTS main.file_spaces (id TEXT PRIMARY KEY, root TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL, embedded INTEGER NOT NULL, is_default INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS main.file_space_default ON file_spaces(is_default) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS main.space_adoptions (space_id TEXT NOT NULL, file_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(space_id,file_id));
CREATE INDEX IF NOT EXISTS main.space_adoption_entity ON space_adoptions(entity_id);
CREATE TABLE IF NOT EXISTS main.ingest_pending (key TEXT PRIMARY KEY, signature TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS main.space_import_seen (space_id TEXT NOT NULL, file_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, PRIMARY KEY(space_id,file_id));
CREATE INDEX IF NOT EXISTS main.space_import_pending ON space_import_seen(space_id,file_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS main.space_import_inputs (space_id TEXT NOT NULL, file_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(space_id,file_id));
CREATE TABLE IF NOT EXISTS main.space_update_cursor (space_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS main.space_updates (space_id TEXT NOT NULL, file_id TEXT NOT NULL, content_version TEXT NOT NULL, error TEXT, PRIMARY KEY(space_id,file_id));
CREATE TABLE IF NOT EXISTS main.file_edits (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS main.file_edit_requests (request_id TEXT PRIMARY KEY, signature TEXT NOT NULL);
`

// 本连接内的文件引用变化与原写入同事务。重开连接或重新关联空间时由完整核对接续。
const referenceChecks = `
CREATE TEMP TABLE IF NOT EXISTS space_reference_checks (
  space_id TEXT NOT NULL, file_id TEXT NOT NULL, PRIMARY KEY(space_id,file_id)
) WITHOUT ROWID;
${['INSERT', 'UPDATE'].map(event => `
CREATE TEMP TRIGGER IF NOT EXISTS check_file_reference_${event} AFTER ${event} ON main.block WHEN NEW.kind='file'
BEGIN
  INSERT INTO space_reference_checks SELECT space_id,file_id FROM space_adoptions WHERE entity_id=NEW.entity_id ON CONFLICT DO NOTHING;
END;
CREATE TEMP TRIGGER IF NOT EXISTS check_adoption_${event} AFTER ${event} ON main.space_adoptions
BEGIN
  INSERT INTO space_reference_checks VALUES(NEW.space_id,NEW.file_id) ON CONFLICT DO NOTHING;
END;`).join('')}
`

const derivedOnly = `
CREATE TABLE IF NOT EXISTS derived.derivation (
  entity_id   TEXT    NOT NULL,
  system      TEXT    NOT NULL,
  input_key   TEXT    NOT NULL,
  plugin_ver  INTEGER NOT NULL,
  config_hash TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (entity_id, system)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS derived.failed_derivations ON derivation(entity_id) WHERE status='failed';

-- 全文索引（设计文档 11.8）：每个可搜索的字段一行；search 的 rowid 就是 search_doc.id
CREATE TABLE IF NOT EXISTS derived.search_doc (
  id        INTEGER PRIMARY KEY,
  entity_id TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  field     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS derived.search_doc_entity ON search_doc(entity_id, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS derived.search USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE IF NOT EXISTS derived.card_summary (
  entity_id  TEXT PRIMARY KEY,
  aspect     REAL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
`

/** 只在仓库受控打开时调用，早于随库空间创建和业务装配。失败回滚本次 SQL 修改。 */
export function prepareLibrarySchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(shared('main') + mainOnly + fileState + shared('derived') + derivedOnly + referenceChecks)
    // 保留已支持的历史增量；分别检查，允许接续只补齐过其中一列的仓库。
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('block_history', 'main')").pluck().all() as string[])
    if (!columns.has('op')) db.exec('ALTER TABLE main.block_history ADD COLUMN op INTEGER')
    if (!columns.has('new_data')) db.exec('ALTER TABLE main.block_history ADD COLUMN new_data TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS main.history_op ON block_history(op)')
    const operations = db.prepare("SELECT name FROM pragma_table_info('operation', 'main')").pluck().all() as string[]
    if (!operations.includes('context')) db.exec('ALTER TABLE main.operation ADD COLUMN context TEXT')
    if (!operations.includes('bytes')) db.exec('ALTER TABLE main.operation ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0')
    db.exec('CREATE INDEX IF NOT EXISTS main.operation_session ON operation(session, id)')
    db.exec(libraryTaskSql + batchReviewSchemaSql)
    const deltaColumns = db.prepare("SELECT name FROM pragma_table_info('review_delta', 'main')").pluck().all()
    if (!deltaColumns.includes('kind_version')) {
      db.exec(`ALTER TABLE main.review_delta ADD COLUMN kind_version INTEGER;
        INSERT INTO main.review_withdrawn
          SELECT DISTINCT d.batch,d.entity_id,s.decided_by,s.decided_at FROM main.review_delta d
          JOIN main.review_sheet s ON s.id=d.batch WHERE s.state='withdrawn'`)
    }
    const taskColumns = db.prepare("SELECT name FROM pragma_table_info('library_task', 'main')").pluck().all()
    if (!taskColumns.includes('state')) db.exec("ALTER TABLE main.library_task ADD COLUMN state TEXT NOT NULL DEFAULT 'active'")
    if (!taskColumns.includes('ended')) db.exec('ALTER TABLE main.library_task ADD COLUMN ended INTEGER')
  }).immediate()
}
