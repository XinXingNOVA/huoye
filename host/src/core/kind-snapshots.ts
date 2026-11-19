import type Database from 'better-sqlite3'

/**
 * 动态定义的快照只在来源与使用者都消失后回收。template 是公共的来源身份标记，
 * 不按插件 ID、命名空间或启停状态判断；静态定义与外部结构契约不在回收范围内。
 * 必须在写事务内、按最终状态调用。历史不作为使用者：撤销先恢复来源，再重建定义。
 */
export function collectUnusedDefinedKinds(db: Database.Database): string[] {
  return db.prepare(`
    DELETE FROM main.kind_def
    WHERE json_type(def, '$.template') = 'text' AND json_extract(def, '$.template') != ''
      AND json_type(def, '$.rebuildable') = 'false'
      AND NOT EXISTS (SELECT 1 FROM main.entity WHERE id = json_extract(kind_def.def, '$.template'))
      -- 来源块仍在但身份异常时也保守保留，不把不一致数据当垃圾。
      AND NOT EXISTS (SELECT 1 FROM main.block WHERE entity_id = json_extract(kind_def.def, '$.template'))
      AND NOT EXISTS (SELECT 1 FROM derived.block WHERE entity_id = json_extract(kind_def.def, '$.template'))
      AND NOT EXISTS (SELECT 1 FROM main.block WHERE kind = kind_def.id)
      AND NOT EXISTS (SELECT 1 FROM derived.block WHERE kind = kind_def.id)
    RETURNING id
  `).pluck().all() as string[]
}
