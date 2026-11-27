// 数据块读写。一次写入只落在一个库里：数据块、字段索引、引用、历史在同一事务中写完。

import { monotonicFactory } from 'ulid'
import type Database from 'better-sqlite3'
import { normalizeBlock, type BlockData, type BlockKind, type Blocks, type EntityIdentity, type EntityView } from '../shared/blocks'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Schema } from './schema'
import { SearchIndex } from './search'
import { unchangedData } from './schema-compatibility'
import { collectUnusedDefinedKinds } from './kind-snapshots'

/** 变化通知：ids 的数据变了；listChanged 表示查询结果可能变了；kinds 是写过的数据块种类。 */
export type ChangeSink = (ids: string[], listChanged: boolean, kinds: ReadonlySet<string>, definitionsChanged: boolean) => void

interface BlockRow {
  entity_id: string
  kind: string
  data: string
  seq: number
  schema_ver: number
}

type Stmt = Database.Statement

interface SchemaStmts {
  getBlock: Stmt
  nextSeq: Stmt
  upsert: Stmt
  delBlock: Stmt
  delIndex: Stmt
  addIndex: Stmt
  delRef: Stmt
  addRef: Stmt
  blocksOf: Stmt
}

export class Store {
  private readonly db: Database.Database
  private readonly newId = monotonicFactory()
  private readonly s: Record<Schema, SchemaStmts>
  /** 全文索引：随写入同步维护，和字段索引一样（设计文档 11.8）。 */
  readonly search: SearchIndex
  private readonly stmt
  private deferDepth = 0
  private pendingIds = new Set<string>()
  private pendingList = false
  private pendingKinds = new Set<string>()
  private pendingDefinitions = false
  private collectDefinitions = false
  private committedTasks?: (() => void)[]

  /** 当前的用户操作（history.ts）：这期间的写入都记在它下面，可以整体撤销。 */
  op: number | null = null
  /** 定义数据块的数据块（模板）：写入后立刻重新注册，同一事务里后面的写入就按新定义校验。 */
  definers = new Set<string>()
  onDefine?: () => void
  private defineDirty = false
  private lastTrashedAt = 0

  constructor(
    lib: Library,
    private readonly reg: Registry,
    private readonly sink: ChangeSink,
    private readonly retireCaches?: (refs: Set<string>) => void
  ) {
    this.db = lib.db
    this.search = new SearchIndex(this.db, reg)
    const prep = (s: Schema): SchemaStmts => ({
      getBlock: this.db.prepare(`SELECT data, seq FROM ${s}.block WHERE entity_id = ? AND kind = ?`),
      nextSeq: this.db.prepare(`UPDATE ${s}.meta SET value = value + 1 WHERE key = 'seq' RETURNING value`),
      upsert: this.db.prepare(
        `INSERT INTO ${s}.block (entity_id, kind, data, schema_ver, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (entity_id, kind) DO UPDATE SET
           data = excluded.data, schema_ver = excluded.schema_ver, seq = excluded.seq, updated_at = excluded.updated_at`
      ),
      delBlock: this.db.prepare(`DELETE FROM ${s}.block WHERE entity_id = ? AND kind = ?`),
      delIndex: this.db.prepare(`DELETE FROM ${s}.field_index WHERE entity_id = ? AND kind = ?`),
      addIndex: this.db.prepare(`INSERT INTO ${s}.field_index (entity_id, kind, field, num, txt) VALUES (?, ?, ?, ?, ?)`),
      delRef: this.db.prepare(`DELETE FROM ${s}.ref WHERE entity_id = ? AND kind = ?`),
      addRef: this.db.prepare(`INSERT INTO ${s}.ref (entity_id, kind, field, target_id, ref_type) VALUES (?, ?, ?, ?, ?)`),
      blocksOf: this.db.prepare(`SELECT entity_id, kind, data, seq, schema_ver FROM ${s}.block WHERE entity_id = ?`)
    })
    this.s = { main: prep('main'), derived: prep('derived') }
    this.stmt = {
      addEntity: this.db.prepare('INSERT INTO main.entity (id, created_at) VALUES (?, ?)'),
      entity: this.db.prepare('SELECT id, created_at, deleted_at FROM main.entity WHERE id = ?'),
      setDeleted: this.db.prepare('UPDATE main.entity SET deleted_at = ? WHERE id = ?'),
      history: this.db.prepare(
        'INSERT INTO main.block_history (entity_id, kind, seq, data, at, op, new_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ),
      identityKinds: this.db.prepare('SELECT kind FROM main.block WHERE entity_id = ?').pluck(),
      attached: this.db.prepare("SELECT DISTINCT entity_id FROM main.ref WHERE target_id = ? AND ref_type = 'attach'").pluck(),
      createdInOperation: this.db.prepare('SELECT 1 FROM main.op_entity WHERE op = ? AND entity_id = ? AND created = 1'),
      opEntity: this.db.prepare(
        'INSERT INTO main.op_entity (op, entity_id, created, before_deleted, after_deleted) VALUES (?, ?, ?, ?, ?)'
      ),
      entities: this.db.prepare(
        'SELECT id, created_at AS createdAt, deleted_at AS deletedAt FROM main.entity WHERE id IN (SELECT value FROM json_each(?))'
      ),
      blocksMany: this.db.prepare(
        `SELECT entity_id, kind, data, seq, schema_ver FROM main.block WHERE entity_id IN (SELECT value FROM json_each(@ids))
         UNION ALL
         SELECT entity_id, kind, data, seq, schema_ver FROM derived.block WHERE entity_id IN (SELECT value FROM json_each(@ids))`
      ),
      failures: this.db.prepare(
        `SELECT entity_id, system, error FROM derived.derivation
         WHERE status = 'failed' AND entity_id IN (SELECT value FROM json_each(?))`
      ),
      purge: [
        'DELETE FROM main.entity WHERE id = ?',
        ...(['main', 'derived'] as const).flatMap((s) => ['block', 'field_index', 'ref'].map((t) => `DELETE FROM ${s}.${t} WHERE entity_id = ?`)),
        'DELETE FROM derived.derivation WHERE entity_id = ?',
        'DELETE FROM derived.card_summary WHERE entity_id = ?'
      ].map((sql) => this.db.prepare(sql)),
      summary: this.db.prepare('SELECT aspect FROM derived.card_summary WHERE entity_id = ?'),
      setSummary: this.db.prepare(
        `INSERT INTO derived.card_summary (entity_id, aspect, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (entity_id) DO UPDATE SET aspect = excluded.aspect, updated_at = excluded.updated_at`
      )
    }
  }

  // ---------- 身份 ----------

  createEntity(createdAt = Date.now(), id = this.newId(createdAt)): string {
    this.stmt.addEntity.run(id, createdAt)
    if (this.op !== null) this.stmt.opEntity.run(this.op, id, 1, null, null)
    this.touch(id, true)
    return id
  }

  exists(id: string): boolean {
    return this.stmt.entity.get(id) !== undefined
  }

  isTrashed(id: string): boolean {
    const row = this.stmt.entity.get(id) as { deleted_at: number | null } | undefined
    return row?.deleted_at != null
  }

  /**
   * 移到回收站。依附在它们身上的身份（例如图片上的局部批注）跟着进去（设计文档 4.6），
   * 和它们记同一个时间，恢复时据此一起回来。
   */
  trash(ids: string[]): void {
    // 时间严格递增：先后两次删除即使在同一毫秒，也分得清哪些是一起进回收站的
    const at = (this.lastTrashedAt = Math.max(Date.now(), this.lastTrashedAt + 1))
    this.batch(() => this.setDeleted(this.withAttached(ids, () => true), at))
  }

  /** 从回收站恢复。和它们一起进回收站的依附者跟着回来；之前就单独删掉的不动。 */
  restore(ids: string[]): void {
    this.batch(() => {
      const when = new Map(ids.map((id) => [id, (this.stmt.entity.get(id) as { deleted_at: number | null } | undefined)?.deleted_at]))
      const all = this.withAttached(ids, (child, parent) => {
        const at = (this.stmt.entity.get(child) as { deleted_at: number | null } | undefined)?.deleted_at
        const parentAt = when.get(parent)
        if (at != null && at === parentAt) when.set(child, at)
        return at != null && at === parentAt
      })
      this.setDeleted(all, null)
    })
  }

  /** 这些身份，加上（层层）依附在它们身上、满足条件的身份（不给条件就是全部）。 */
  withAttached(ids: string[], accept: (child: string, parent: string) => boolean = () => true): string[] {
    const out = new Set(ids)
    const queue = [...ids]
    while (queue.length) {
      const parent = queue.shift()!
      for (const child of this.stmt.attached.all(parent) as string[]) {
        if (out.has(child) || !accept(child, parent)) continue
        out.add(child)
        queue.push(child)
      }
    }
    return [...out]
  }

  private setDeleted(ids: string[], at: number | null): void {
    this.batch(() => {
      for (const id of ids) {
        const row = this.stmt.entity.get(id) as { deleted_at: number | null } | undefined
        if (!row || (row.deleted_at === null) === (at === null)) continue
        if (this.op !== null) this.stmt.opEntity.run(this.op, id, 0, row.deleted_at, at)
        this.stmt.setDeleted.run(at, id)
        this.touch(id, true)
      }
    })
  }

  /**
   * 彻底删除（设计文档 11.13）：身份连同它的数据块、索引、加工记录一起从库里去掉。不记历史，撤销不了。
   * 别的身份指向它们的关联引用留着（悬空，保留原值）。磁盘上的文件、历史里的记录由调用方处理。
   */
  purge(ids: string[]): void {
    this.batch(() => {
      for (const id of ids) {
        const blocks = this.blocksOf(id)
        const kinds = Object.keys(blocks)
        for (const k of kinds) this.touchPreviousOwner(k, blocks[k].data)
        if (kinds.length || this.exists(id)) this.collectDefinitions = true
        for (const st of this.stmt.purge) st.run(id)
        this.search.removeEntity(id)
        this.touch(id, true)
        // 定义数据块的数据块（模板）没了：删掉之后重新注册
        for (const kind of kinds) { this.touch(id, true, kind); this.defined(kind) }
      }
    })
  }

  /** 撤销、重做时直接设回某个状态，不记操作。 */
  setDeletedAt(id: string, at: number | null): void {
    this.stmt.setDeleted.run(at, id)
    this.touch(id, true)
    // 旧操作可能早于成员转入；重放作品状态时也要带上它目前拥有的记录。
    for (const child of this.stmt.attached.all(id) as string[]) {
      if (!this.recordKind(child)?.ownedBy) continue
      this.stmt.setDeleted.run(at, child)
      this.touch(child, true)
    }
  }

  /** 收录这类异步过程结束后，把新建的身份补记到当前操作里。 */
  recordCreated(id: string): void {
    if (this.op !== null) this.stmt.opEntity.run(this.op, id, 1, null, null)
  }

  private recordKind(id: string): BlockKind | undefined {
    return (this.stmt.identityKinds.all(id) as string[]).map(k => this.reg.kind(k)).find(k => k?.management || k?.ownedBy)
  }

  countOwnedRecords(ids: string[]): number {
    if (!ids.length) return 0
    const kinds = this.reg.allKinds().filter(k => k.ownedBy).map(k => k.id)
    if (!kinds.length) return 0
    return this.db.prepare(`SELECT count(DISTINCT entity_id) FROM main.block
      WHERE entity_id IN (SELECT value FROM json_each(?)) AND kind IN (SELECT value FROM json_each(?))`)
      .pluck().get(JSON.stringify(ids), JSON.stringify(kinds)) as number
  }

  assertMaterials(ids: string[]): void {
    for (const id of ids) {
      const record = this.recordKind(id)
      if (record?.management) throw new Error('插件管理记录请在所属插件中管理')
      if (record?.ownedBy) throw new Error('从属记录请在所属作品中管理')
    }
  }

  /** 从属记录只作为依附者随行；管理记录仍由所属插件独立管理。 */
  lifecycleFamily(ids: string[]): string[] {
    const roots = new Set(ids), family = this.withAttached(ids)
    for (const id of family) {
      const record = this.recordKind(id)
      if (record?.management) throw new Error('插件管理记录请在所属插件中管理')
      if (record?.ownedBy && roots.has(id)) throw new Error('从属记录请在所属作品中管理')
    }
    return family
  }

  /** 一个物理删除也记入操作；原文件不能通过这条路径删除。 */
  deleteRecord(id: string, plugin: string): void {
    const def = this.recordKind(id)
    if (!def || def.plugin !== plugin || def.dormant) throw new Error('只能删除本插件启用的管理记录或从属记录')
    if (def.ownedBy && this.isTrashed(id)) throw new Error('请先恢复所属作品再移除从属记录')
    const blocks = this.blocksOf(id)
    for (const kind of Object.keys(blocks)) {
      const k = this.reg.kind(kind)
      if (!k || k.content || Object.values(k.fields).some(f => f.file)) throw new Error('此记录含有内容、文件或未知数据块，不能直接删除')
    }
    if (this.withAttached([id]).length > 1) throw new Error('此记录有依附内容，不能直接删除')
    // 同一个命令中新建又删掉的临时记录没有前后状态，不能在撤销时复活空身份。
    if (this.op !== null && this.stmt.createdInOperation.get(this.op, id)) {
      this.db.prepare('DELETE FROM main.block_history WHERE op = ? AND entity_id = ?').run(this.op, id)
      this.db.prepare('DELETE FROM main.op_entity WHERE op = ? AND entity_id = ?').run(this.op, id)
      this.purge([id])
      return
    }
    const row = this.stmt.entity.get(id) as { created_at: number; deleted_at: number | null }
    if (this.op !== null) this.db.prepare('INSERT INTO main.record_history VALUES (?, ?, ?, ?, ?)').run(this.op, id, row.created_at, row.deleted_at, 'deleted')
    // 包括旧版误附加的元数据；全部保留到历史，撤销可恢复原值。
    for (const b of this.op === null ? [] : this.s.main.blocksOf.all(id) as BlockRow[]) {
      const seq = (this.s.main.nextSeq.get() as { value: number }).value
      this.stmt.history.run(id, b.kind, seq, b.data, Date.now(), this.op, null)
    }
    this.purge([id])
  }

  /** 管理及从属记录的创建也用同一份身份快照撤销。 */
  recordCreations(): void {
    const rows = this.db.prepare('SELECT e.id, e.created_at FROM main.op_entity o JOIN main.entity e ON e.id = o.entity_id WHERE o.op = ? AND o.created = 1').all(this.op) as { id: string; created_at: number }[]
    for (const row of rows) if (this.recordKind(row.id)) {
      this.db.prepare('INSERT OR IGNORE INTO main.record_history VALUES (?, ?, ?, NULL, ?)').run(this.op, row.id, row.created_at, 'created')
    }
  }

  restoreIdentity(id: string, createdAt: number, deletedAt: number | null): void {
    this.db.prepare('INSERT OR IGNORE INTO main.entity VALUES (?, ?, ?)').run(id, createdAt, deletedAt)
    this.touch(id, true)
  }

  /** 只清理启用插件声明的旧空容器；有额外数据的记录保留。 */
  cleanEmptyManagement(): void {
    this.batch(() => {
      for (const def of this.reg.allKinds()) {
        const field = def.management?.emptyWhen
        if (!field || def.dormant) continue
        const ids = this.db.prepare('SELECT entity_id FROM main.block WHERE kind = ?').pluck().all(def.id) as string[]
        for (const id of ids) {
          const blocks = this.blocksOf(id)
          const value = blocks[def.id]?.data[field]
          if (Object.keys(blocks).length === 1 && Array.isArray(value) && value.length === 0 && this.withAttached([id]).length === 1) this.purge([id])
        }
      }
    })
  }

  // ---------- 数据块 ----------

  /** 挂上或修改一个数据块。数据没有变化时不写入，写入序号也不变。 */
  /** raw：原样写回，不按定义校验（撤销时写回当时有效的内容）。 */
  put(id: string, kind: string, data: BlockData, raw = false, producer?: string): void {
    const def = this.reg.requireKind(kind)
    if (def.dormant && !raw) throw new Error(`「${def.title}」所属的插件在这个仓库里没有启用，不能修改`)
    const clean = raw ? data : normalizeBlock(def, data)
    if (!raw) {
      const kinds = (this.stmt.identityKinds.all(id) as string[]).map(k => this.reg.kind(k))
      const managed = kinds.find(k => k?.management)
      if (def.ownedBy) {
        if (kinds.some(k => k?.id !== kind) || this.isTrashed(id)) throw new Error('从属记录必须是独立的活跃身份')
        if (!kinds.length && (this.op === null || !this.stmt.createdInOperation.get(this.op, id))) throw new Error('请在插件命令中新建从属身份')
        const owner = clean[def.ownedBy]
        if (typeof owner !== 'string' || this.isTrashed(owner) || !(this.stmt.identityKinds.all(owner) as string[]).some(k => this.reg.kind(k)?.content)) {
          throw new Error('从属记录必须归属一个活跃的内容素材')
        }
      } else if (kinds.some(k => k?.ownedBy)) {
        throw new Error('从属记录不能附加其他数据块')
      }
      if (!def.container && !def.allowOnContainer && kinds.some(k => k?.container)) throw new Error(`容器不支持附加或修改「${def.title}」数据块`)
      // 已升级的容器可能留有旧版附加块，允许继续维护容器本身。
      if (def.container && !kinds.some(k => k?.id === kind) && kinds.some(k => !k?.allowOnContainer || k.container)) throw new Error('已有素材或其他容器身份，不能改为此容器')
      const ownCache = def.rebuildable && producer === def.plugin && def.plugin === managed?.plugin && !Object.values(def.fields).some(f => f.file)
      if ((managed && managed.id !== kind && !ownCache) || (def.management && !managed && Object.keys(this.blocksOf(id)).some(k => k !== kind))) {
        throw new Error('插件管理记录不能附加素材数据块，也不能附加到素材上')
      }
    }
    const json = JSON.stringify(clean)
    const schema = this.reg.schemaOf(kind)
    const st = this.s[schema]
    this.batch(() => {
      const old = st.getBlock.get(id, kind) as { data: string } | undefined
      if (old?.data === json) return
      const now = Date.now()
      const seq = (st.nextSeq.get() as { value: number }).value
      if (this.op !== null && !def.rebuildable && def.history !== false) this.stmt.history.run(id, kind, seq, old?.data ?? null, now, this.op, json)
      if (old && def.rebuildable) this.retireProviderImages(def, old.data, clean)
      if (old && def.ownedBy) this.touchPreviousOwner(kind, JSON.parse(old.data))
      st.upsert.run(id, kind, json, def.version, seq, now)
      this.writeIndexes(st, def, id, clean)
      this.defined(kind)
      this.touch(id, !old || hasIndexedFields(def), kind)
    })
  }

  /** 换版和加工都可能撤下派生块。仅在提交后核对已退出该字段的托管产物。 */
  private retireProviderImages(def: BlockKind, oldJson: string, next?: BlockData) {
    if (!this.retireCaches || !oldJson.includes('cache/provider-images/')) return
    const before: BlockData = JSON.parse(oldJson)
    const retired = new Set<string>()
    for (const [key, field] of Object.entries(def.fields)) {
      const previous = before[key], current = next?.[key]
      if (!field.file || previous === current) continue
      for (const ref of Array.isArray(previous) ? previous : [previous]) {
        if (typeof ref === 'string' && ref.startsWith('cache/provider-images/') && !(Array.isArray(current) && current.includes(ref))) retired.add(ref)
      }
    }
    if (retired.size) this.afterCommit(() => this.retireCaches?.(retired))
  }

  // 删除或转入另一作品后，旧归属已经无法从 ref 反查。随同一批通知复核旧作品。
  private touchPreviousOwner(kind: string, data: BlockData) {
    const field = this.reg.kind(kind)?.ownedBy
    if (field && typeof data[field] === 'string') this.pendingIds.add(data[field] as string)
  }

  private defined(kind: string): void {
    if (!this.definers.has(kind)) return
    this.defineDirty = true
    this.onDefine?.()
  }

  /**
   * 撤销、重做：把数据块写回某个时刻的内容（null 表示没有这块）。
   * 定义已经不在了的（例如它的模板被撤销掉）原样写回，不建索引。
   */
  restoreBlock(id: string, kind: string, json: string | null): void {
    if (json === null) return this.remove(id, kind, true)
    if (this.reg.kind(kind)) return this.put(id, kind, JSON.parse(json) as BlockData, true)
    const st = this.s.main
    this.db.transaction(() => {
      const old = st.getBlock.get(id, kind) as { data: string } | undefined
      if (old?.data === json) return
      const seq = (st.nextSeq.get() as { value: number }).value
      if (this.op !== null) this.stmt.history.run(id, kind, seq, old?.data ?? null, Date.now(), this.op, json)
      st.upsert.run(id, kind, json, 1, seq, Date.now())
    })()
    this.touch(id, true, kind)
  }

  /** 移除一个数据块。 */
  remove(id: string, kind: string, replay = false): void {
    const known = this.reg.kind(kind)
    if (known?.dormant && !replay) throw new Error(`「${known.title}」所属的插件在这个仓库里没有启用，不能修改`)
    if (!replay && known?.ownedBy) throw new Error('请使用所属插件的记录删除命令')
    if (!replay && known?.content && !(this.stmt.identityKinds.all(id) as string[]).some(k => k !== kind && this.reg.kind(k)?.content) &&
      (this.stmt.attached.all(id) as string[]).some(child => this.recordKind(child)?.ownedBy)) {
      throw new Error('作品仍有从属记录，不能单独移除最后的内容块')
    }
    const schema = known ? this.reg.schemaOf(kind) : undefined
    const schemas: Schema[] = schema ? [schema] : ['main', 'derived']
    let removed = false
    this.batch(() => {
      for (const s of schemas) {
        const st = this.s[s]
        const old = st.getBlock.get(id, kind) as { data: string } | undefined
        if (!old) continue
        if (known?.rebuildable) this.retireProviderImages(known, old.data)
        if (known?.ownedBy) this.touchPreviousOwner(kind, JSON.parse(old.data))
        const seq = (st.nextSeq.get() as { value: number }).value
        if (this.op !== null && s === 'main' && this.reg.kind(kind)?.history !== false) this.stmt.history.run(id, kind, seq, old.data, Date.now(), this.op, null)
        st.delBlock.run(id, kind)
        st.delIndex.run(id, kind)
        st.delRef.run(id, kind)
        this.search.remove(id, kind)
        removed = true
      }
      if (removed) {
        this.collectDefinitions = true
        this.defined(kind)
        this.touch(id, true, kind)
      }
    })
  }

  private writeIndexes(st: SchemaStmts, def: BlockKind, id: string, data: BlockData): void {
    st.delIndex.run(id, def.id)
    st.delRef.run(id, def.id)
    this.search.write(id, def, data)
    for (const [name, f] of Object.entries(def.fields)) {
      const value = data[name]
      if (value === undefined) continue
      const values = f.list ? (value as unknown[]) : [value]
      if (f.index) {
        for (const v of values) {
          const numeric = f.type === 'number' || f.type === 'date' || f.type === 'boolean'
          const num = numeric ? (f.type === 'boolean' ? (v ? 1 : 0) : (v as number)) : null
          st.addIndex.run(id, def.id, name, num, numeric ? null : String(v))
        }
      }
      if (f.type === 'ref') {
        for (const v of values) st.addRef.run(id, def.id, name, v as string, f.ref!)
      }
    }
  }

  // ---------- 读取 ----------

  blocksOf(id: string, kinds?: string[]): Blocks {
    if (kinds) {
      const rows = (['main', 'derived'] as const).flatMap(s => this.db.prepare(
        `SELECT entity_id, kind, data, seq, schema_ver FROM ${s}.block WHERE entity_id = ? AND kind IN (SELECT value FROM json_each(?))`
      ).all(id, JSON.stringify(kinds)) as BlockRow[])
      return toBlocks(rows)
    }
    const rows = [
      ...(this.s.main.blocksOf.all(id) as BlockRow[]),
      ...(this.s.derived.blocksOf.all(id) as BlockRow[])
    ]
    return toBlocks(rows)
  }

  getIdentities(ids: string[]): EntityIdentity[] {
    return this.stmt.entities.all(JSON.stringify(ids)) as EntityIdentity[]
  }

  get(ids: string[]): EntityView[] {
    if (ids.length === 0) return []
    const json = JSON.stringify(ids)
    const entities = this.stmt.entities.all(json) as EntityIdentity[]
    const blockRows = this.stmt.blocksMany.all({ ids: json }) as BlockRow[]
    const failRows = this.stmt.failures.all(json) as { entity_id: string; system: string; error: string | null }[]

    const byId = new Map<string, EntityView>()
    for (const e of entities) {
      byId.set(e.id, { ...e, blocks: {}, failures: {} })
    }
    for (const r of blockRows) {
      const v = byId.get(r.entity_id)
      if (v) v.blocks[r.kind] = { data: JSON.parse(r.data), seq: r.seq, ver: r.schema_ver }
    }
    for (const f of failRows) {
      const v = byId.get(f.entity_id)
      if (v) v.failures[f.system] = f.error ?? '未知错误'
    }
    return ids.flatMap((id) => byId.get(id) ?? [])
  }

  findByField(kind: string, field: string, value: string | number): string | undefined {
    const def = this.reg.requireKind(kind)
    const f = def.fields[field]
    if (!f?.index) throw new Error(`字段 ${kind}.${field} 没有索引`)
    const col = typeof value === 'number' ? 'num' : 'txt'
    const row = this.db
      .prepare(`SELECT entity_id FROM ${this.reg.schemaOf(kind)}.field_index WHERE kind = ? AND field = ? AND ${col} = ? LIMIT 1`)
      .get(kind, field, value) as { entity_id: string } | undefined
    return row?.entity_id
  }

  // ---------- 迁移 ----------

  /** 打开库时调用：把旧版本的数据块升级到当前定义。 */
  migrate(): void {
    for (const def of this.reg.allKinds()) {
      if (def.dormant) continue
      const schema = this.reg.schemaOf(def.id)
      const rows = this.db
        .prepare(`SELECT entity_id, kind, data, seq, schema_ver FROM ${schema}.block WHERE kind = ? AND schema_ver < ?`)
        .all(def.id, def.version) as BlockRow[]
      if (rows.length === 0) continue

      if (def.rebuildable) {
        // 可重建的数据块不迁移，删掉后由加工 System 重新生成
        this.batch(() => {
          for (const r of rows) this.remove(r.entity_id, def.id)
          this.db.prepare('DELETE FROM derived.derivation WHERE entity_id IN (SELECT value FROM json_each(?))').run(
            JSON.stringify(rows.map((r) => r.entity_id))
          )
        })
        continue
      }

      const step = this.reg.migration(def.id)
      if (rows.every(r => this.reg.compatibleVersion(def.id, r.schema_ver))) {
        this.batch(() => {
          for (const r of rows) {
            unchangedData(def, JSON.parse(r.data))
            this.db.prepare('UPDATE main.block SET schema_ver = ? WHERE entity_id = ? AND kind = ?').run(def.version, r.entity_id, def.id)
          }
        })
        continue
      }
      if (!step) throw new Error(`数据块 ${def.id} 从版本 ${rows[0].schema_ver} 升级到 ${def.version} 缺少迁移函数`)
      this.batch(() => {
        for (const r of rows) {
          let data = JSON.parse(r.data) as BlockData
          for (let v = r.schema_ver; v < def.version; v++) data = step(data, v)
          this.put(r.entity_id, def.id, data)
          // 值没变时 put 不重写记录，结构版本仍须升级，否则每次开库会重复迁移。
          this.db.prepare('UPDATE main.block SET schema_ver = ? WHERE entity_id = ? AND kind = ?').run(def.version, r.entity_id, def.id)
        }
      })
    }
  }

  // ---------- 卡片摘要与变化通知 ----------

  /** 内部提交后副作用；外部直接开启的 SQL 事务无法确认提交，保守跳过。
   * 不向插件开放，也不用于必须持久接续的业务任务。
   */
  afterCommit(task: () => void): void {
    if (!this.db.inTransaction) task()
    else this.committedTasks?.push(task)
  }

  /** 同步批量写入：一个事务，结束时统一通知。 */
  batch<T>(fn: () => T): T {
    const outer = !this.db.inTransaction
    if (outer) this.committedTasks = []
    const tasks = this.committedTasks, mark = tasks?.length ?? 0
    this.deferDepth++
    try {
      let collected: string[] = []
      const result = this.db.transaction(() => {
        const value = fn()
        // 不在嵌套写入的中间状态回收；预演、失败和快照删除一起回滚。
        if (outer && this.collectDefinitions) collected = collectUnusedDefinedKinds(this.db)
        return value
      })()
      if (collected.length) {
        // 事务提交后才撤下休眠定义，回滚无需恢复这部分内存状态。
        this.reg.removeDormant(collected)
        this.pendingDefinitions = true
      }
      if (outer) {
        this.committedTasks = undefined
        for (const task of tasks ?? []) {
          try { task() } catch (error) { console.error('[store] 提交后清理失败', error) }
        }
      }
      return result
    } catch (e) {
      if (tasks) tasks.length = mark
      // 回滚了：如果中途改过定义，按回滚后的库重新注册
      if (this.deferDepth === 1 && this.defineDirty) this.onDefine?.()
      throw e
    } finally {
      if (outer) { this.collectDefinitions = false; this.committedTasks = undefined }
      this.deferDepth--
      if (this.deferDepth === 0) {
        this.defineDirty = false
        this.flush()
      }
    }
  }

  /** 异步过程中推迟通知，结束时统一发出（不包事务）。 */
  async defer<T>(fn: () => Promise<T>): Promise<T> {
    this.deferDepth++
    try {
      return await fn()
    } finally {
      this.deferDepth--
      if (this.deferDepth === 0) this.flush()
    }
  }

  private touch(id: string, listChanged: boolean, kind?: string): void {
    this.pendingIds.add(id)
    if (listChanged) this.pendingList = true
    if (kind) this.pendingKinds.add(kind)
    if (this.deferDepth === 0) this.flush()
  }

  private flush(): void {
    if (this.pendingIds.size === 0 && !this.pendingDefinitions) return
    const ids = [...this.pendingIds]
    let list = this.pendingList
    const kinds = this.pendingKinds
    const definitionsChanged = this.pendingDefinitions
    this.pendingIds = new Set()
    this.pendingList = false
    this.pendingKinds = new Set()
    this.pendingDefinitions = false
    this.db.transaction(() => {
      for (const id of ids) if (this.updateSummary(id)) list = true
    })()
    this.sink(ids, list, kinds, definitionsChanged)
  }

  /** 重新计算卡片摘要（单值扩展点的仲裁结果），返回是否变化。 */
  private updateSummary(id: string): boolean {
    // 彻底删除了的身份没有摘要
    if (!this.exists(id)) return true
    const aspect = this.reg.aspectOf(this.blocksOf(id)) ?? null
    const old = this.stmt.summary.get(id) as { aspect: number | null } | undefined
    if (old && old.aspect === aspect) return false
    this.stmt.setSummary.run(id, aspect, Date.now())
    return true
  }
}

function toBlocks(rows: BlockRow[]): Blocks {
  const blocks: Blocks = {}
  for (const r of rows) blocks[r.kind] = { data: JSON.parse(r.data), seq: r.seq, ver: r.schema_ver }
  return blocks
}

function hasIndexedFields(def: BlockKind): boolean {
  return Object.values(def.fields).some((f) => f.index || f.type === 'ref')
}
