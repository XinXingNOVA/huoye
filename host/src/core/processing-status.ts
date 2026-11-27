// 只观察调度器的权威记录，不创建任务，不把“还有旧输出”误报为加工成功。
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Blocks } from '../shared/blocks'
import { processingStatusSchema, type ProcessingKindStatus, type ProcessingStatus, type ProcessingStatusInput } from '../shared/processing-status'
import type { RegisteredSystem, Registry } from './registry'
import type { Store } from './store'

interface Derivation { input_key: string; plugin_ver: number; status: string; error: string | null; updated_at: number }
interface Runtime {
  blockedSystems: ReadonlyMap<string, string>
  key(system: RegisteredSystem, id: string, blocks: Blocks): string | undefined
  relatedRevision(id: string, blocks: Blocks): string[]
  related(system: RegisteredSystem, id: string): string[]
  target(blocks: Blocks): string | undefined
  phase(id: string, system: RegisteredSystem): 'running' | 'queued' | undefined
}
export class ProcessingReader {
  private readonly session = randomUUID()
  private readonly records: Database.Statement
  constructor(db: Database.Database, private reg: Registry, private store: Store, private runtime: Runtime) {
    this.records = db.prepare('SELECT system, input_key, plugin_ver, status, error, updated_at FROM derived.derivation WHERE entity_id = ?')
  }
  read(raw: ProcessingStatusInput): ProcessingStatus {
    const { ids, kinds } = processingStatusSchema.parse(raw)
    const items = new Map(this.store.get([...new Set(ids)]).map(item => [item.id, item]))
    const blocks = new Map<string, Blocks>()
    const records = new Map<string, Map<string, Derivation>>()
    const memo = new Map<string, ProcessingKindStatus>()
    const getBlocks = (id: string) => {
      if (!blocks.has(id)) blocks.set(id, items.get(id)?.blocks ?? this.store.blocksOf(id))
      return blocks.get(id)!
    }
    const recordOf = (id: string, system: string) => {
      if (!records.has(id)) records.set(id, new Map((this.records.all(id) as (Derivation & { system: string })[]).map(row => [row.system, row])))
      return records.get(id)!.get(system)
    }
    const inspect = (id: string, kind: string, path = new Set<string>()): ProcessingKindStatus => {
      const key = `${id}|${kind}`
      if (memo.has(key)) return memo.get(key)!
      const state = evaluate(id, kind, path)
      memo.set(key, state)
      return state
    }
    const evaluate = (id: string, kind: string, path: Set<string>): ProcessingKindStatus => {
      const key = `${id}|${kind}`, b = getBlocks(id), seq = b[kind]?.seq
      const result = (state: ProcessingKindStatus['state'], extra: Partial<ProcessingKindStatus> = {}): ProcessingKindStatus => ({ kind, state, ...(seq === undefined ? {} : { seq }), ...extra })
      if (path.has(key) || path.size >= 64) return result('blocked', { reason: '加工依赖循环或层级过深' })
      const next = new Set(path).add(key), def = this.reg.kind(kind)
      if (!def || def.dormant) return result('blocked', { reason: !def ? '未知的数据块，请先 describe_library' : '所属插件未装载' })
      if (!def.rebuildable) return result(seq === undefined ? 'empty' : 'ready')
      let disabled: string | undefined
      for (const system of this.reg.producersOf(kind)) {
        const reason = this.runtime.blockedSystems.get(system.id)
        if (reason) { disabled = reason; continue }
        // 缺少不可加工的识别条件时，这个产出者肯定不适用。
        if (system.has.some(k => !b[k] && !this.reg.kind(k)?.rebuildable)) continue
        const source = { system: system.id, plugin: system.plugin }
        const dependencies = system.has.filter(k => this.reg.kind(k)?.rebuildable).map(k => inspect(id, k, next))
        const target = this.runtime.target(b)
        if (target) for (const spec of system.targetKinds) {
          const k = spec.kind
          if (this.reg.kind(k)?.rebuildable) dependencies.push(inspect(target, k, next))
        }
        // 上游暂时没有输出／仍是旧输出时，不能凭旧数据仲裁下游产出者。
        if (dependencies.some(d => d.state === 'pending')) return result('pending', { ...source, phase: 'dependencies' })
        const failure = dependencies.find(d => d.state === 'failed' || d.state === 'blocked')
        if (failure) return result('blocked', { ...source, reason: `依赖 ${failure.kind} ${failure.state}：${failure.reason ?? '暂不可用'}`.slice(0, 1000) })
        if (system.has.some(k => !b[k]) || dependencies.some(d => d.state === 'empty' || d.state === 'skipped')) continue
        try { if (system.match && !system.match(b)) continue }
        catch (error) { return result('blocked', { ...source, reason: `识别条件失败：${String(error)}`.slice(0, 1000) }) }
        // 关联输入可以缺封面，但正在重新加工的来源不能使旧合成图被报告为就绪。
        if (system.relatedInputs && this.runtime.related(system, id).some(sourceId =>
          system.relatedInputs!.sourceKinds.some(k => this.reg.kind(k)?.rebuildable && inspect(sourceId, k, next).state === 'pending'))) {
          return result('pending', { ...source, phase: 'dependencies' })
        }
        const row = recordOf(id, system.id)
        if (row && row.input_key === this.runtime.key(system, id, b) && row.plugin_ver === system.pluginVersion) {
          return result(row.status === 'failed' ? 'failed' : row.status === 'skipped' ? 'skipped' : seq === undefined ? 'empty' : 'ready',
            { ...source, updatedAt: row.updated_at, ...(row.error ? { reason: row.error.slice(0, 1000) } : {}) })
        }
        const phase = this.runtime.phase(id, system)
        if (system.demand && !phase) return result('blocked', { ...source, reason: '需要显式触发按需加工；只读查询不会触发' })
        return result('pending', { ...source, phase: phase ?? 'queued' })
      }
      return result(disabled || !this.reg.producersOf(kind).length ? 'blocked' : 'skipped',
        { reason: disabled ?? (!this.reg.producersOf(kind).length ? '没有可用的产出者' : '不满足加工识别条件') })
    }
    const rawRevision = (id: string) => Object.entries(getBlocks(id)).filter(([kind]) => !this.reg.kind(kind)?.rebuildable)
      .sort(([a], [b]) => a.localeCompare(b)).map(([kind, block]) => [kind, block.seq])
    return { session: this.session, items: [...new Set(ids)].map(id => {
      const item = items.get(id), target = item && this.runtime.target(item.blocks)
      const relations = this.runtime.relatedRevision(id, getBlocks(id))
      const revision = createHash('sha256').update(JSON.stringify([this.session, id, item?.deletedAt, rawRevision(id), target, target ? rawRevision(target) : null, ...relations])).digest('hex')
      if (!item || item.deletedAt) return { id, revision, state: item ? 'trashed' : 'missing', kinds: [] }
      const states = [...new Set(kinds)].map(kind => inspect(id, kind))
      return { id, revision, state: states.some(s => s.state === 'pending') ? 'pending' : 'settled', kinds: states }
    }) }
  }
}
