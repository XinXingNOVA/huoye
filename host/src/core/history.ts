// 撤销与重做（设计文档 11.6）。
// 每个用户操作（改字段、放入视图、移到回收站、改模板结构……）是一个操作；它引起的数据块写入记在
// block_history 里（写入前后的内容都有），身份的新建、进出回收站记在 op_entity 里。
// 撤销 = 把这些数据块写回写入前的内容；重做 = 写回写入后的内容。
// 定义先于数据：模板这类定义数据块的数据块先写回、重新注册，再写回数据，两个方向都是。
// 只撤销这一次运行里的操作：重启后的撤销会让人不知道撤销的是什么。可撤销的范围是线性的，
// 撤销后又做了新操作，被撤销的那些就不能再重做。
import type Database from 'better-sqlite3'
import type { Store } from './store'
import { historyPageSchema, historyDetailSchema, historyGuardSchema, type HistoryContext, type HistoryEntry, type HistoryPageInput, type HistoryPage, type HistoryDetailInput, type HistoryDetail, type HistoryGuard } from '../shared/history'

interface HistoryRow {
  entity_id: string
  kind: string
  data: string | null
  new_data: string | null
}

interface OperationRow { id: number; label: string; at: number; state: HistoryEntry['state']; context: string | null }

interface RecordRow { entity_id: string; created_at: number; deleted_at: number | null; action: 'created' | 'deleted' }

interface EntityRow {
  entity_id: string
  created: number
  before_deleted: number | null
  after_deleted: number | null
}

const MAX_OPERATIONS = 1000
const MAX_BYTES = 64 * 1024 * 1024

export class History {
  readonly session: number
  private revision = 0
  private nextId: number
  private trimmed = 0
  // 空操作没有撤销项，仍可在本次会话为外部整理批次核对这笔回执。
  private readonly emptyRequests = new Map<string, HistoryContext>()
  unchangedRequest(id: string) { return this.emptyRequests.get(id) }
  private readonly stmt

  constructor(
    private readonly db: Database.Database,
    private readonly store: Store,
    private readonly changed: () => void = () => {}
  ) {
    this.session = Math.max(Date.now(), Number(db.prepare('SELECT MAX(session) FROM main.operation').pluck().get() ?? 0) + 1)
    // 不复用本次会话里因空操作、回滚或永久清除留下的 ID，避免旧详情指向新操作。
    this.nextId = Number(db.prepare('SELECT MAX(id) FROM main.operation').pluck().get() ?? 0) + 1
    this.stmt = {
      begin: db.prepare("INSERT INTO main.operation (id, session, label, at, state, context) VALUES (?, ?, '', ?, 'done', ?)"),
      label: db.prepare('UPDATE main.operation SET label = ?, context = json_patch(context, ?) WHERE id = ?'),
      drop: db.prepare('DELETE FROM main.operation WHERE id = ?'),
      touched: db.prepare(
        'SELECT (SELECT COUNT(*) FROM main.block_history WHERE op = @op) + (SELECT COUNT(*) FROM main.op_entity WHERE op = @op) + (SELECT COUNT(*) FROM main.record_history WHERE op = @op)'
      ),
      redoIds: db.prepare("SELECT id FROM main.operation WHERE session = ? AND state = 'undone'").pluck(),
      // 只在操作完成或永久清除其部分身份时计量一次，不反复扫描所有历史正文。
      measure: db.prepare(`UPDATE main.operation SET bytes =
        length(CAST(label AS BLOB)) + length(CAST(COALESCE(context, '') AS BLOB)) +
        (SELECT COALESCE(SUM(length(CAST(COALESCE(data, '') AS BLOB)) + length(CAST(COALESCE(new_data, '') AS BLOB))
          + length(CAST(entity_id AS BLOB)) + length(CAST(kind AS BLOB)) + 24), 0) FROM main.block_history WHERE op=@op) +
        (SELECT COALESCE(SUM(length(CAST(entity_id AS BLOB)) + 32), 0) FROM main.op_entity WHERE op=@op) +
        (SELECT COALESCE(SUM(length(CAST(entity_id AS BLOB)) + 32), 0) FROM main.record_history WHERE op=@op)
        WHERE id=@op`),
      lastDone: db.prepare("SELECT id, label FROM main.operation WHERE session = ? AND state = 'done' ORDER BY id DESC LIMIT 1"),
      firstUndone: db.prepare("SELECT id, label FROM main.operation WHERE session = ? AND state = 'undone' ORDER BY id ASC LIMIT 1"),
      setState: db.prepare('UPDATE main.operation SET state = ? WHERE id = ?'),
      rows: db.prepare('SELECT entity_id, kind, data, new_data FROM main.block_history WHERE op = ? ORDER BY seq'),
      records: db.prepare('SELECT * FROM main.record_history WHERE op = ?'),
      forgetRecords: db.prepare('DELETE FROM main.record_history WHERE entity_id IN (SELECT value FROM json_each(?))'),
      entities: db.prepare('SELECT entity_id, created, before_deleted, after_deleted FROM main.op_entity WHERE op = ?'),
      opsOf: db
        .prepare(
          `SELECT op FROM main.block_history WHERE entity_id IN (SELECT value FROM json_each(@ids)) AND op IS NOT NULL
           UNION SELECT op FROM main.op_entity WHERE entity_id IN (SELECT value FROM json_each(@ids))
           UNION SELECT op FROM main.record_history WHERE entity_id IN (SELECT value FROM json_each(@ids))`
        )
        .pluck(),
      forgetHistory: db.prepare('DELETE FROM main.block_history WHERE entity_id IN (SELECT value FROM json_each(?))'),
      forgetEntities: db.prepare('DELETE FROM main.op_entity WHERE entity_id IN (SELECT value FROM json_each(?))')
    }
  }

  /** 宿主完整装配成功后开始新会话；结构准备、插件校验和失败打开不清理历史。 */
  startSession(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM main.block_history; DELETE FROM main.op_entity; DELETE FROM main.record_history; DELETE FROM main.operation;')
    })()
  }

  private dropOperations(ids: number[]): void {
    if (!ids.length) return
    const json = JSON.stringify(ids)
    for (const table of ['block_history', 'op_entity', 'record_history'])
      this.db.prepare(`DELETE FROM main.${table} WHERE op IN (SELECT value FROM json_each(?))`).run(json)
    this.db.prepare('DELETE FROM main.operation WHERE id IN (SELECT value FROM json_each(?))').run(json)
  }

  /** 在新操作同一事务中按完整操作裁剪；撤销／重做不裁剪，避免破坏重做前置关系。 */
  private retain(): void {
    this.dropOperations(this.stmt.redoIds.all(this.session) as number[])
    const rows = this.db.prepare('SELECT id, bytes FROM main.operation WHERE session=? ORDER BY id DESC').all(this.session) as { id: number; bytes: number }[]
    let bytes = 0, keep = 0
    for (const row of rows) {
      if (keep > 0 && (keep >= MAX_OPERATIONS || bytes + row.bytes > MAX_BYTES)) break
      bytes += row.bytes; keep++ // 最新一笔即使超预算也完整保留。
    }
    const removed = rows.slice(keep)
    this.dropOperations(removed.map(row => row.id))
    if (removed.length) this.store.afterCommit(() => { this.trimmed += removed.length })
  }

  /**
   * 一次用户操作：期间的写入都记在它下面，同一个事务。没写任何东西的操作不留下。
   * label 可以按结果来写（例如"放进 3 项"）。在另一个操作里面调用时，并入外层。
   */
  run<T>(label: string | ((result: T) => string), fn: () => T, context: HistoryContext = {}): T {
    if (this.store.op !== null) return fn()
    return this.store.batch(() => {
      const op = this.nextId++
      this.stmt.begin.run(op, this.session, Date.now(), JSON.stringify(context))
      this.store.op = op
      let result: T
      try {
        result = fn()
        this.store.recordCreations()
      } finally {
        this.store.op = null
      }
      if (!this.stmt.touched.pluck().get({ op })) {
        this.stmt.drop.run(op)
        if (context.source === 'external' && context.requestId) this.store.afterCommit(() => {
          this.emptyRequests.set(context.requestId!, context)
          if (this.emptyRequests.size > MAX_OPERATIONS) this.emptyRequests.delete(this.emptyRequests.keys().next().value!)
        })
      } else {
        this.stmt.label.run(typeof label === 'function' ? label(result) : label, JSON.stringify(context), op)
        this.stmt.measure.run({ op })
        this.retain()
        this.notify()
      }
      return result
    })
  }

  /**
   * 彻底删除了这些身份（设计文档 11.13）：历史里关于它们的记录一并去掉，撤销、重做不会再把它们带回来；
   * 去掉之后什么也不剩的操作整个删掉，撤销时直接跳过。原件内容由文件空间版本协议管理。
   */
  forget(ids: string[]): void {
    const json = JSON.stringify(ids)
    this.forgetOperations(this.ownerOperations(ids))
    const ops = new Set(this.stmt.opsOf.all({ ids: json }) as number[])
    this.stmt.forgetHistory.run(json)
    this.stmt.forgetEntities.run(json)
    this.stmt.forgetRecords.run(json)
    for (const op of ops) {
      if (!this.stmt.touched.pluck().get({ op })) this.stmt.drop.run(op)
      else {
        this.db.prepare("UPDATE main.operation SET context=json_set(COALESCE(context,'{}'),'$.partial',1) WHERE id=?").run(op)
        this.stmt.measure.run({ op })
      }
    }
    if (ops.size) this.notify()
  }

  /** 已移除或移出作品的从属项仍可能在历史中。清除会重放失效归属的操作。 */
  ownerOperations(ids: string[]): number[] {
    if (!ids.length) return []
    return this.db.prepare(`WITH owners AS (SELECT value FROM json_each(@ids)),
      kinds AS (SELECT id, json_extract(def,'$.ownedBy') field FROM main.kind_def WHERE json_type(def,'$.ownedBy') = 'text')
      SELECT DISTINCT h.op FROM kinds k JOIN main.block_history h ON h.kind=k.id
      WHERE h.op IS NOT NULL AND h.entity_id NOT IN owners AND (
        EXISTS (SELECT 1 FROM json_each(h.data) WHERE key=k.field AND value IN owners)
        OR EXISTS (SELECT 1 FROM json_each(h.new_data) WHERE key=k.field AND value IN owners))`).pluck().all({ ids: JSON.stringify(ids) }) as number[]
  }

  /** 维护删除使整笔操作失效；不留下只能部分重放的跨插件操作。调用方在同一数据事务内执行。 */
  forgetOperations(ids: number[]): void {
    this.dropOperations(ids)
    if (ids.length) this.notify()
  }

  undo(expected?: HistoryGuard): string | undefined {
    const op = this.stmt.lastDone.get(this.session) as { id: number; label: string } | undefined
    this.check(expected, op?.id)
    if (!op) return undefined
    this.replay(op.id, 'undo')
    return op.label
  }

  redo(expected?: HistoryGuard): string | undefined {
    const op = this.stmt.firstUndone.get(this.session) as { id: number; label: string } | undefined
    this.check(expected, op?.id)
    if (!op) return undefined
    this.replay(op.id, 'redo')
    return op.label
  }

  private notify(): void {
    this.store.afterCommit(() => { this.revision++; this.changed() })
  }

  private check(expected: HistoryGuard | undefined, id: number | undefined): void {
    if (expected === undefined) return
    const guard = historyGuardSchema.parse(expected)
    if (guard.session !== this.session || guard.revision !== this.revision || guard.id !== id)
      throw new Error('[HISTORY_CHANGED] 操作历史已变化，请刷新后再试')
  }

  private entry(row: OperationRow): HistoryEntry {
    const context: HistoryContext = row.context ? JSON.parse(row.context) : {}
    const affected = Number(this.db.prepare(`SELECT COUNT(*) FROM (${affectedSql})`).pluck().get({ op: row.id }))
    const kinds = this.db.prepare('SELECT DISTINCT kind FROM main.block_history WHERE op=? ORDER BY kind LIMIT 31').pluck().all(row.id) as string[]
    return { id: row.id, at: row.at, label: row.label, state: row.state, source: context.source ?? 'application',
      plugin: context.plugin, operation: context.operation, requestId: context.requestId, affected, kinds: kinds.slice(0, 30), kindsTruncated: kinds.length > 30 }
  }

  page(raw: HistoryPageInput = {}): HistoryPage {
    const input = historyPageSchema.parse(raw)
    const filter = "session=@session AND (@request IS NULL OR json_extract(context, '$.requestId')=@request)"
    const params = { session: this.session, request: input.requestId ?? null }
    const rows = this.db.prepare(`SELECT * FROM main.operation WHERE ${filter} AND (@before IS NULL OR id<@before) ORDER BY id DESC LIMIT @limit`)
      .all({ ...params, before: input.before ?? null, limit: input.limit + 1 }) as OperationRow[]
    return { session: this.session, revision: this.revision,
      retention: { limit: MAX_OPERATIONS, byteLimit: MAX_BYTES, trimmed: this.trimmed,
        bytes: Number(this.db.prepare('SELECT COALESCE(SUM(bytes), 0) FROM main.operation WHERE session=?').pluck().get(this.session)) },
      entries: rows.slice(0, input.limit).map(row => this.entry(row)),
      total: Number(this.db.prepare(`SELECT COUNT(*) FROM main.operation WHERE ${filter}`).pluck().get(params)),
      nextBefore: rows.length > input.limit ? rows[input.limit - 1].id : null,
      undo: (this.stmt.lastDone.get(this.session) as HistoryPage['undo']) ?? null,
      redo: (this.stmt.firstUndone.get(this.session) as HistoryPage['redo']) ?? null }
  }

  detail(raw: HistoryDetailInput): HistoryDetail {
    const input = historyDetailSchema.parse(raw)
    const row = this.db.prepare('SELECT * FROM main.operation WHERE session=? AND id=?').get(this.session, input.id) as OperationRow | undefined
    if (!row) throw new Error('[HISTORY_UNAVAILABLE] 记录不在本次会话中，或已清理（保留上限、放弃重做或永久清除素材）')
    const entry = this.entry(row)
    const rows = this.db.prepare(`SELECT a.entity_id AS id, e.id AS existing, e.deleted_at FROM (${affectedSql}) a LEFT JOIN main.entity e ON e.id=a.entity_id ORDER BY a.entity_id LIMIT @limit OFFSET @offset`)
      .all({ op: row.id, limit: input.limit, offset: input.offset }) as { id: string; existing: string | null; deleted_at: number | null }[]
    const kindsOf = this.db.prepare('SELECT DISTINCT kind FROM main.block_history WHERE op=? AND entity_id=? ORDER BY kind LIMIT 31').pluck()
    return { session: this.session, revision: this.revision, entry,
      entities: rows.map(r => { const kinds = kindsOf.all(row.id, r.id) as string[]; return { id: r.id, exists: r.existing !== null, trashed: r.deleted_at !== null, kinds: kinds.slice(0, 30), kindsTruncated: kinds.length > 30 } }),
      nextOffset: input.offset + rows.length < entry.affected ? input.offset + rows.length : null }
  }

  private replay(op: number, direction: 'undo' | 'redo'): void {
    const undo = direction === 'undo'
    this.store.batch(() => {
      const records = this.stmt.records.all(op) as RecordRow[]
      const entities = this.stmt.entities.all(op) as EntityRow[]
      // 新建素材的撤销是移入回收站，初始数据和原文件索引仍须保留。
      // 管理记录通过 record_history 物理增删，继续重放其字段。
      const creations = new Set(entities.filter(e => e.created && !records.some(r => r.entity_id === e.entity_id)).map(e => e.entity_id))
      const restoring = (r: RecordRow) => undo ? r.action === 'deleted' : r.action === 'created'
      for (const r of records.filter(restoring)) this.store.restoreIdentity(r.entity_id, r.created_at, r.deleted_at)
      const rows = this.stmt.rows.all(op) as HistoryRow[]
      if (undo) rows.reverse()
      // 定义先于数据
      const isDefiner = (r: HistoryRow) => this.store.definers.has(r.kind)
      for (const r of [...rows.filter(isDefiner), ...rows.filter((r) => !isDefiner(r))]) {
        if (creations.has(r.entity_id)) continue
        this.store.restoreBlock(r.entity_id, r.kind, undo ? r.data : r.new_data)
      }
      const now = Date.now()
      for (const e of entities) {
        if (records.some(r => r.entity_id === e.entity_id)) continue
        // 普通素材的新建撤销仍进入回收站
        if (undo) this.store.setDeletedAt(e.entity_id, e.created ? now : e.before_deleted)
        else this.store.setDeletedAt(e.entity_id, e.created ? null : e.after_deleted)
      }
      this.store.purge(records.filter(r => !restoring(r)).map(r => r.entity_id))
      this.stmt.setState.run(undo ? 'undone' : 'done', op)
      this.notify()
    })
  }
}

const affectedSql = `SELECT entity_id FROM main.block_history WHERE op=@op
  UNION SELECT entity_id FROM main.op_entity WHERE op=@op
  UNION SELECT entity_id FROM main.record_history WHERE op=@op`
