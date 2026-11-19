// 为验收单和任务草稿记住后续覆盖，即使人把字段改回同值或重开仓库也保留这次接手。
// 稳定字段名和列表成员来自块定义与历史快照。原始数据仍由 block 独占。
// 对有成员差异的字段各比较一次保留成员的顺序。手动重排后，原批次的成员位置已失效。
const common = (list: string, other: string) =>
  `(SELECT json_group_array(value ORDER BY key) FROM json_each(${list}) WHERE value IN (SELECT value FROM json_each(${other})))`
const reorderedLists = `field IN (
  WITH names AS MATERIALIZED (SELECT DISTINCT field FROM review_delta
    WHERE entity_id=NEW.entity_id AND kind=NEW.kind AND member<>'' AND touched=0),
  lists AS MATERIALIZED (SELECT field, OLD.data -> ('$.' || json_quote(field)) a, NEW.data -> ('$.' || json_quote(field)) b FROM names)
  SELECT field FROM lists WHERE a IS NOT b AND (b='[]' OR ${common('a','b')} <> ${common('b','a')})
)`
function watchBlock(event: 'INSERT' | 'UPDATE' | 'DELETE') {
  const row = event === 'DELETE' ? 'OLD' : 'NEW'
  // 移除整块代表接手整块；人在新加入的模板内编辑过，也保留模板成员身份。
  const value = "NEW.data -> ('$.' || json_quote(field))"
  const differs = event === 'DELETE' ? '1' : `CASE
    WHEN field='' THEN ${event === 'UPDATE' ? 'OLD.data <> NEW.data' : "final <> 'true'"}
    WHEN member<>'' THEN (SELECT count(*) FROM json_each(${value}) WHERE value=member) <> (final='true') ${event === 'UPDATE' ? 'OR ' + reorderedLists : `OR ${value}='[]'`}
    ELSE final <> COALESCE(${value}, 'null') END`
  return `DROP TRIGGER IF EXISTS main.review_watch_v2_${event};
  CREATE TRIGGER IF NOT EXISTS main.review_watch_v3_${event} AFTER ${event} ON block BEGIN
    UPDATE review_delta SET touched=1
    WHERE entity_id=${row}.entity_id AND kind=${row}.kind AND touched=0
      AND EXISTS (SELECT 1 FROM review_sheet WHERE id=review_delta.batch AND state IN ('pending','draft'))
      AND NOT EXISTS (SELECT 1 FROM review_withdrawn w WHERE w.batch=review_delta.batch AND w.entity_id=review_delta.entity_id)
      AND (${differs});
  END;`
}
// 组单前的普通写入可从 block_history 逐笔核对。撤销重做等无历史写入只留会话内的序号。
function watchUnlogged(event: 'INSERT' | 'UPDATE' | 'DELETE') {
  const row = event === 'DELETE' ? 'OLD' : 'NEW'
  const seq = event === 'DELETE' ? "(SELECT value FROM main.meta WHERE key='seq')" : 'NEW.seq'
  return `CREATE TEMP TRIGGER IF NOT EXISTS review_unlogged_${event} AFTER ${event} ON main.block
    WHEN EXISTS (SELECT 1 FROM main.block_history WHERE entity_id=${row}.entity_id AND kind=${row}.kind) AND NOT EXISTS (
      SELECT 1 FROM main.block_history WHERE entity_id=${row}.entity_id AND kind=${row}.kind AND seq=${seq} AND op IS NOT NULL)
    BEGIN
      INSERT INTO review_unlogged VALUES (${row}.entity_id,${row}.kind,${seq}) ON CONFLICT(entity_id,kind) DO UPDATE SET seq=excluded.seq;
    END;`
}

export const batchReviewSchemaSql = `
CREATE TABLE IF NOT EXISTS main.review_sheet (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, signature TEXT NOT NULL UNIQUE, requests TEXT NOT NULL, unchanged TEXT NOT NULL,
  state TEXT NOT NULL, created INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS main.review_delta (
  batch TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL, field TEXT NOT NULL, member TEXT NOT NULL,
  title TEXT NOT NULL, prior TEXT NOT NULL, final TEXT NOT NULL, position INTEGER NOT NULL,
  template_seq INTEGER, touched INTEGER NOT NULL, kind_version INTEGER,
  PRIMARY KEY(batch, entity_id, kind, field, member)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS main.review_delta_block ON review_delta(entity_id, kind, touched);
CREATE INDEX IF NOT EXISTS main.review_delta_kind ON review_delta(kind);
CREATE TABLE IF NOT EXISTS main.review_withdrawn (
  batch TEXT NOT NULL, entity_id TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at INTEGER NOT NULL, PRIMARY KEY(batch,entity_id)
) WITHOUT ROWID;
DROP TRIGGER IF EXISTS main.review_drop_sheet;
CREATE TRIGGER IF NOT EXISTS main.review_drop_sheet_v2 AFTER DELETE ON review_sheet BEGIN
  DELETE FROM review_delta WHERE batch=OLD.id;
  DELETE FROM review_withdrawn WHERE batch=OLD.id;
END;
DROP TRIGGER IF EXISTS main.review_purge_entity;
CREATE TRIGGER IF NOT EXISTS main.review_purge_entity_v2 BEFORE DELETE ON entity BEGIN
  DELETE FROM review_sheet WHERE id IN (SELECT batch FROM review_delta WHERE entity_id=OLD.id OR kind IN (SELECT id FROM kind_def WHERE json_extract(def,'$.template')=OLD.id));
END;
DROP TRIGGER IF EXISTS main.review_watch_INSERT;
DROP TRIGGER IF EXISTS main.review_watch_UPDATE;
DROP TRIGGER IF EXISTS main.review_watch_DELETE;
${watchBlock('INSERT')}
${watchBlock('UPDATE')}
${watchBlock('DELETE')}
`

export const batchReviewSessionSql = `
CREATE TEMP TABLE IF NOT EXISTS review_unlogged (entity_id TEXT, kind TEXT, seq INTEGER NOT NULL, PRIMARY KEY(entity_id,kind)) WITHOUT ROWID;
${watchUnlogged('INSERT')}
${watchUnlogged('UPDATE')}
${watchUnlogged('DELETE')}
`
