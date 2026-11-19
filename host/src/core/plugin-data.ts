import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { History } from './history'
import type { CorePlugin } from './plugin'
import type { PluginInfo } from '../shared/plugin-plan'
import type { BlockKind } from '../shared/blocks'
import { canonical } from '../shared/external-plugins'
import { fileReference } from '../shared/file-location'
import { pluginDataRequestSchema, pluginDataCleanupSchema, pluginDataRetrySchema, type PluginDataInfo, type PluginDataRequest, type PluginDataCleanupInput, type PluginDataPreview, type PluginDataCleanupResult } from '../shared/plugin-data'
import { registrationKey, type PluginDataRegistration } from './plugin-data-registration'

type Row = { entity_id: string; kind: string; data: string; seq: number; storage: 'main' | 'derived' }
type Cache = { reference: string; stamp: string }
type Receipt = { result: PluginDataCleanupResult; pending: Cache[] }
const receiptKey = (id: string) => `pluginDataCleanup:${id}`
const key = (row: Pick<Row, 'entity_id' | 'kind'>) => `${row.entity_id}\0${row.kind}`

/** 仓库级显式维护。只使用宿主持久快照；不调用待清理插件的代码。 */
export class PluginData {
  constructor(private lib: Library, private reg: Registry, private store: Store, private history: History,
    private active: CorePlugin[], private enabled: Set<string>, private manifest: PluginInfo[], private kindsChanged: () => void) {}

  private read<T>(name: string): T | undefined {
    const json = this.lib.db.prepare('SELECT value FROM main.config WHERE key=?').pluck().get(name) as string | undefined
    return json ? JSON.parse(json) as T : undefined
  }
  private write(name: string, value: unknown): void {
    this.lib.db.prepare('INSERT INTO main.config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
  private definitions(): BlockKind[] {
    return (this.lib.db.prepare('SELECT def FROM main.kind_def ORDER BY id').pluck().all() as string[]).map(s => JSON.parse(s))
  }
  private rows(): Row[] {
    return this.lib.db.prepare("SELECT entity_id,kind,data,seq,'main' AS storage FROM main.block UNION ALL SELECT entity_id,kind,data,seq,'derived' AS storage FROM derived.block ORDER BY entity_id,kind").all() as Row[]
  }
  private registration(id: string): PluginDataRegistration | undefined { return this.read(registrationKey(id)) }
  private isEnabled(id: string): boolean { return this.enabled.has(id) || this.active.some(p => p.id === id) }
  private isProtected(id: string): boolean { return !!this.registration(id)?.protected || !!this.manifest.find(p => p.id === id)?.required }

  list(): PluginDataInfo[] {
    const defs = this.definitions()
    const ids = new Set(defs.map(k => k.plugin))
    const configs = this.lib.db.prepare("SELECT key FROM main.config WHERE key GLOB 'pluginData:*' OR key GLOB 'externalSchema:*' OR key GLOB 'pluginDataCleanup:*' OR key GLOB 'externalDefinitions:*'").pluck().all() as string[]
    for (const name of configs) ids.add(name.slice(name.indexOf(':') + 1))
    const counts = this.lib.db.prepare("SELECT kind, COUNT(*) AS n, 'main' AS storage FROM main.block GROUP BY kind UNION ALL SELECT kind, COUNT(*), 'derived' FROM derived.block GROUP BY kind").all() as {kind: string; n: number; storage: string}[]
    return [...ids].sort().map(id => {
      const own = defs.filter(k => k.plugin === id).map(k => k.id), registration = this.registration(id)
      return { pluginId: id, title: this.manifest.find(p => p.id === id)?.title ?? registration?.title ?? id,
        enabled: this.isEnabled(id), protected: this.isProtected(id), declared: !!registration?.lifecycle, kinds: own,
        persistentBlocks: counts.filter(c => c.storage === 'main' && own.includes(c.kind)).reduce((n,c) => n+c.n, 0),
        derivedBlocks: counts.filter(c => c.storage === 'derived' && own.includes(c.kind)).reduce((n,c) => n+c.n, 0),
        hasSchemaContract: this.read(`externalSchema:${id}`) !== undefined || this.read(`externalDefinitions:${id}`) !== undefined,
        pendingCaches: this.read<Receipt>(receiptKey(id))?.pending.length ?? 0 }
    })
  }

  private plan(input: PluginDataRequest) {
    const { pluginId: id, mode } = input, db = this.lib.db
    const defs = this.definitions(), own = defs.filter(k => k.plugin === id), ownIds = new Set(own.map(k => k.id))
    const definition = new Map(defs.map(k => [k.id, k])), rows = this.rows(), registration = this.registration(id)
    const blocked: string[] = [], retained = new Map<string, string>()
    if (this.isEnabled(id)) blocked.push('请先停用插件并重载仓库，再进行数据维护')
    if (mode === 'all' && this.isProtected(id)) blocked.push('核心必需功能不能清除持久数据')
    if (this.reg.systems.some(s => s.outputs.some(k => ownIds.has(k)))) blocked.push('仍有启用中的插件会加工这些数据，请先停用相关加工者并重载')
    if (this.reg.systems.some(s => s.plugin !== id && registration?.systems.some(old => old.id === s.id))) blocked.push('加工系统 ID 已由其他插件使用，不能清除其运行记录')
    if (db.prepare('SELECT 1 FROM main.ingest_pending LIMIT 1').get()) blocked.push('请先完成或取消未完成的收录任务')
    if (this.read<Receipt>(receiptKey(id))?.pending.length) blocked.push('上次缓存清理尚未完成，请先重试')
    if (!own.length && !registration && this.read(`externalSchema:${id}`) === undefined && this.read(`externalDefinitions:${id}`) === undefined) blocked.push('没有此插件的持久登记')
    const selected = rows.filter(r => ownIds.has(r.kind) && (mode === 'all' || r.storage === 'derived'))
    const removable = new Set(selected.map(key)), entities = new Set<string>()
    const byEntity = new Map<string, Row[]>()
    for (const row of rows) {
      const group = byEntity.get(row.entity_id) ?? []
      group.push(row); byEntity.set(row.entity_id, group)
    }
    const records = new Set(registration?.lifecycle?.disposableRecords ?? [])
    const retain = (entity: string, reason: string) => {
      retained.set(entity, reason)
      for (const row of byEntity.get(entity) ?? []) if (row.storage === 'main' && ownIds.has(row.kind)) removable.delete(key(row))
      entities.delete(entity)
    }
    if (mode === 'all') {
      for (const entity of new Set(selected.filter(r => r.storage === 'main').map(r => r.entity_id))) {
        const all = byEntity.get(entity)!, persistent = all.filter(r => r.storage === 'main')
        const foreign = persistent.filter(r => !ownIds.has(r.kind))
        const anchored = foreign.some(r => { const k = definition.get(r.kind); return k?.content || k?.standalone || k?.management })
        const originals = persistent.some(r => ownIds.has(r.kind) && Object.values(definition.get(r.kind)?.fields ?? {}).some(f => f.file))
        if (originals) { retain(entity, '含原件引用，需通过文件空间流程处理'); continue }
        if (all.every(r => ownIds.has(r.kind)) && persistent.some(r => records.has(r.kind))) entities.add(entity)
        else if (!anchored) retain(entity, foreign.length ? '含其他插件或未知数据，保留身份及本插件持久块' : '未声明可销毁的独立记录，保留以免产生空壳')
      }
      // 只保护清理后仍然存在的引用；不级联删除其他插件的子项。动态定义的来源也算引用。
      let changed = true
      while (changed) {
        changed = false
        const protect = (target: string) => {
          if (entities.has(target)) { retain(target, '仍被保留的数据或定义引用'); changed = true }
        }
        for (const row of rows) if (!removable.has(key(row))) visitStrings(JSON.parse(row.data), protect)
        const remainingKinds = new Set(rows.filter(r => !removable.has(key(r))).map(r => r.kind))
        for (const def of defs) if (!ownIds.has(def.id) || remainingKinds.has(def.id)) {
          if (def.template) protect(def.template)
        }
      }
    }
    const remove = selected.filter(r => removable.has(key(r)))
    const resetSchema = mode === 'all' && !rows.some(r => ownIds.has(r.kind) && !removable.has(key(r)))
    // 完整操作失效，避免跨插件批次只撤销一半。没清掉的混合记录仍保留自身历史。
    const histories = db.prepare('SELECT rowid,* FROM main.block_history ORDER BY rowid').all() as {entity_id: string; kind: string; op: number | null}[]
    const affectedHistory = histories.filter(h => entities.has(h.entity_id) || removable.has(key(h)) || (mode === 'all' && ownIds.has(h.kind) && !retained.has(h.entity_id)))
    const ops = new Set(affectedHistory.flatMap(h => h.op === null ? [] : [h.op]))
    for (const table of ['op_entity', 'record_history']) {
      const hs = db.prepare(`SELECT op,entity_id FROM main.${table}`).all() as {op: number; entity_id: string}[]
      for (const h of hs) if (entities.has(h.entity_id)) ops.add(h.op)
    }
    const caches = new Set<string>()
    for (const row of remove.filter(r => r.storage === 'derived')) {
      const data = JSON.parse(row.data)
      for (const [field, f] of Object.entries(definition.get(row.kind)?.fields ?? {})) if (f.file) {
        for (const value of f.list && Array.isArray(data[field]) ? data[field] : [data[field]]) {
          const reference = cacheReference(value)
          if (reference) caches.add(reference)
        }
      }
    }
    for (const row of rows) if (!removable.has(key(row))) visitStrings(JSON.parse(row.data), s => { const r = cacheReference(s); if (r) caches.delete(r) })
    const pending: Cache[] = [], retainedCaches: string[] = []
    for (const reference of caches) {
      try { const stamp = this.stamp(reference); if (stamp) pending.push({ reference, stamp }) }
      catch { retainedCaches.push(reference) } // 不可验证的路径不授权删除。
    }
    const retainedEffects = [...(registration?.lifecycle?.retainedEffects ?? [])]
    if (!registration?.lifecycle) retainedEffects.push('旧插件未提供生命周期声明；只处理可核验的数据块与缓存，未声明影响不作已清零承诺')
    if (registration?.systems.some(s => s.outputs.some(k => !ownIds.has(k)))) retainedEffects.push('该插件曾加工其他插件定义的数据块；共享产物保留，不按加工者推断删除权限')
    retainedEffects.push('文件空间原件、应用本地设置与密钥、插件包与启停选择、外部操作回执保留')
    const reviewIds = mode === 'all' ? db.prepare('SELECT DISTINCT batch FROM main.review_delta WHERE kind IN (SELECT value FROM json_each(?)) ORDER BY batch').pluck().all(JSON.stringify([...ownIds])) as string[] : []
    const token = createHash('sha256').update(canonical({ input, rows, defs, registration, histories, reviewIds,
      operations: db.prepare('SELECT * FROM main.operation ORDER BY id').all(),
      entityHistory: db.prepare('SELECT * FROM main.op_entity ORDER BY op,entity_id').all(),
      records: db.prepare('SELECT * FROM main.record_history ORDER BY op,entity_id').all(),
      schema: this.read(`externalSchema:${id}`), definitions: this.read(`externalDefinitions:${id}`), pending, blocked })).digest('hex')
    const counts = new Map<string, number>()
    for (const row of remove) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
    const removedKinds = [...counts].map(([id, blocks]) => ({ id, title: definition.get(id)?.title ?? id, blocks }))
    const preview: PluginDataPreview = { ...input, token, blocked, blocks: remove.length, removedKinds, entities: entities.size,
      preservedEntities: new Set(remove.filter(r => !entities.has(r.entity_id)).map(r => r.entity_id)).size,
      cacheFiles: pending.length, historyOperations: ops.size, reviewBatches: reviewIds.length, resetSchema,
      retained: [...retained].map(([id, reason]) => ({ id, reason })), retainedEffects }
    return { preview, remove, entities, own, ops, reviewIds, affectedHistory, pending, retainedCaches, registration }
  }

  preview(raw: PluginDataRequest): PluginDataPreview { return this.plan(pluginDataRequestSchema.parse(raw)).preview }

  cleanup(raw: PluginDataCleanupInput): PluginDataCleanupResult {
    const input = pluginDataCleanupSchema.parse(raw), id = input.pluginId
    const previous = this.read<Receipt>(receiptKey(id))
    if (previous?.result.token === input.token && previous.result.mode === input.mode) return this.retry({ pluginId: id })
    if (this.lib.db.inTransaction) throw new Error('[PLUGIN_DATA_BUSY] 维护不能嵌入其他操作事务')
    this.store.batch(() => {
      const plan = this.plan({ pluginId: id, mode: input.mode }), { preview } = plan
      if (preview.blocked.length) throw new Error(`[PLUGIN_DATA_BLOCKED] ${preview.blocked.join('；')}`)
      if (preview.token !== input.token) throw new Error('[PLUGIN_DATA_CHANGED] 数据已变化，请重新预览')
      for (const row of plan.remove) if (!plan.entities.has(row.entity_id)) this.store.remove(row.entity_id, row.kind, true)
      this.store.purge([...plan.entities])
      this.history.forgetOperations([...plan.ops])
      if (plan.reviewIds.length) this.lib.db.prepare('DELETE FROM main.review_sheet WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(plan.reviewIds))
      // 非操作历史也可能保存旧值，避免清理后留下可恢复副本。
      for (const h of plan.affectedHistory) this.lib.db.prepare('DELETE FROM main.block_history WHERE entity_id=? AND kind=? AND op IS NULL').run(h.entity_id, h.kind)
      for (const system of plan.registration?.systems ?? []) this.lib.db.prepare('DELETE FROM derived.derivation WHERE system=?').run(system.id)
      if (preview.resetSchema) {
        for (const kind of plan.own) this.lib.db.prepare('DELETE FROM main.kind_def WHERE id=?').run(kind.id)
        for (const name of [`externalSchema:${id}`, `externalDefinitions:${id}`]) this.lib.db.prepare('DELETE FROM main.config WHERE key=?').run(name)
        this.store.afterCommit(() => { this.reg.removeDormant(plan.own.map(k => k.id)); this.kindsChanged() })
      }
      const result: PluginDataCleanupResult = { pluginId: id, mode: input.mode, token: input.token, blocks: preview.blocks, removedKinds: preview.removedKinds, entities: preview.entities,
        historyOperations: preview.historyOperations, reviewBatches: preview.reviewBatches, resetSchema: preview.resetSchema, removedCaches: 0,
        pendingCaches: plan.pending.map(c => ({ reference: c.reference, error: '等待清理' })), retainedCaches: plan.retainedCaches,
        retained: preview.retained, retainedEffects: preview.retainedEffects }
      // 数据事务与候选路径一起提交；宕机或 unlink 失败可重试，不重复删数据。
      this.write(receiptKey(id), { result, pending: plan.pending } satisfies Receipt)
    })
    return this.retry({ pluginId: id })
  }

  private stamp(reference: string): string | undefined {
    try {
      const stat = statSync(this.lib.files.resolve(reference))
      if (!stat.isFile()) throw new Error('缓存引用不是文件')
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }

  retry(raw: { pluginId: string }): PluginDataCleanupResult {
    const { pluginId: id } = pluginDataRetrySchema.parse(raw), receipt = this.read<Receipt>(receiptKey(id))
    if (!receipt) throw new Error('[NOT_FOUND] 没有待接续的插件清理')
    // 第一批已提交回执没有分类明细；缺失不等于清理了零种，不据此重新执行。
    receipt.result.removedKinds ??= []
    if (!receipt.pending.length) return receipt.result
    if (this.lib.db.inTransaction || this.isEnabled(id)) throw new Error('[PLUGIN_DATA_BUSY] 请在插件停用后的独立维护步骤重试')
    const referenced = new Set<string>()
    const scan = (json: string | null) => { if (json) visitStrings(JSON.parse(json), s => { const r = cacheReference(s); if (r) referenced.add(r) }) }
    for (const row of this.rows()) scan(row.data)
    for (const row of this.lib.db.prepare('SELECT data,new_data FROM main.block_history').all() as {data: string | null; new_data: string | null}[]) { scan(row.data); scan(row.new_data) }
    const pending: Cache[] = [], errors: PluginDataCleanupResult['pendingCaches'] = []
    for (const cache of receipt.pending) {
      try {
        const stamp = this.stamp(cache.reference)
        if (referenced.has(cache.reference) || (stamp && stamp !== cache.stamp)) receipt.result.retainedCaches.push(cache.reference)
        else if (stamp) { this.lib.files.removeCache(cache.reference); receipt.result.removedCaches++ }
      } catch (e) { pending.push(cache); errors.push({ reference: cache.reference, error: e instanceof Error ? e.message : String(e) }) }
    }
    receipt.pending = pending; receipt.result.pendingCaches = errors
    this.write(receiptKey(id), receipt)
    return receipt.result
  }
}

function cacheReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try { const ref = fileReference(value); return ref.startsWith('cache/') ? ref : undefined } catch { return undefined }
}
function visitStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) for (const item of value) visitStrings(item, visit)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) visitStrings(item, visit)
}
