// 加工调度：按加工记录找出需要处理的身份，不依赖事件是否送达。
// 新鲜度 = 输入块的写入序号（+ 依附目标上声明的数据块的写入序号）+ 插件版本（+ 设置哈希，暂未使用）。
//
// 每个 System 有自己的待检查集合：数据变化时放进去，检查一次就清空；
// 启动、安装插件时对 System 做一次全量扫描。这样大批量导入时也不会反复扫描同一批身份。

import type Database from 'better-sqlite3'
import type { Blocks } from '../shared/blocks'
import type { JobContext, SystemContext } from './plugin'
import type { Registry, RegisteredSystem } from './registry'
import type { Store } from './store'
import { createHash } from 'node:crypto'
import { renderJobImage, stageImageArtifact } from './job-image'
import { RelatedReader, relatedDigest } from './related-inputs'
import { ProcessingReader } from './processing-status'
import type { ProcessingStatusInput, ProcessingSummary } from '../shared/processing-status'

/** 全量扫描时每次取出的工作数量。 */
const BATCH = 200

export interface SchedulerOptions {
  /** 在输入仍有效时，原子替换派生图像文件。 */
  writeCache?: (path: string, bytes: Buffer) => void
  /** 加工结束时再次核对原文件可用性，防止读取期间空间原件发生外部变化。 */
  validateFile?: (reference: string) => void
  /** 同时运行的加工总数。 */
  concurrency?: number
  /** 本次装配中缺少程序或能力的加工任务及原因。 */
  blockedSystems: ReadonlyMap<string, string>
  capabilities: import('./capabilities').LibraryCapabilities
  /** 这个仓库里停用的插件的 System：它们的加工记录留着，重新启用时不用全部重算。 */
  retain?: string[]
  onProgress?: (running: number, busy: boolean) => void
  /** 单个加工的进度（按需加工时显示给用户）。 */
  onJob?: (event: JobEvent) => void
}

const jobKey = (id: string, system: string) => `${id}|${system}`

type JobEvent = import('../shared/rpc').CoreEvents['job']
type JobOutcome = Exclude<JobEvent['phase'], 'progress'>
interface RunningJob {
  progress?: number
  id: string
  abort: AbortController
  mediaSeq?: number
  retryDemand?: boolean
}

export class Scheduler {
  private readonly concurrency: number

  /** 可运行的 System：按需加工的排在前面，其余按 priority。 */
  private readonly systems: RegisteredSystem[]
  private readonly jobs = new Map<string, RunningJob>()
  private readonly runningBy = new Map<string, number>()
  private readonly queues = new Map<string, string[]>()
  private readonly pending = new Map<string, Set<string>>()
  private readonly fullScan = new Set<string>()
  private readonly demanded = new Map<string, Set<string>>()
  // 仅记录因空间离线而实际取消的工作。会话重开会按加工记录重新扫描。
  private readonly interruptedBySpace = new Set<string>()
  private visible: string[] = []
  private scheduled = false
  private idleWaiters: (() => void)[] = []
  private settleWaiters: { done(): boolean; resolve(): void }[] = []
  private stopped = false
  private readonly record: Database.Statement
  private readonly attempts: Database.Statement
  private readonly engineKeys = new Map<string, string>()
  private readonly relations = new Map<string, RelatedReader>()
  private readonly reader: ProcessingReader

  constructor(
    private readonly db: Database.Database,
    private readonly reg: Registry,
    private readonly store: Store,
    private readonly ctx: SystemContext,
    private readonly opts: SchedulerOptions
  ) {
    this.concurrency = opts.concurrency ?? 4
    for (const system of reg.systems) {
      const pluginPrograms = reg.plugins.find(p => p.id === system.plugin)?.requires?.programs ?? []
      const programs = [...pluginPrograms, ...system.requires?.programs ?? []]
      const ids = [...opts.capabilities.systemCapabilities(system.plugin, system), ...programs.map(name => 'program:' + name)]
      const key = opts.capabilities.fingerprint(ids)
      const previous = opts.capabilities.previousFingerprints(ids).filter(old => old !== key).sort()
      if (previous.length && !opts.blockedSystems.has(system.id)) {
        const marker = 'portable-engine-key-v2:' + system.id
        const value = JSON.stringify([key, previous])
        db.transaction(() => {
          if (db.prepare('SELECT 1 FROM derived.meta WHERE key=? AND value=?').get(marker, value)) return
          // All legacy engine suffixes are SHA-256 and have the same length.
          const length = previous[0].length
          db.prepare(`UPDATE derived.derivation SET input_key = substr(input_key, 1, length(input_key) - ?) || ?
            WHERE system = ? AND status <> 'failed' AND substr(input_key, -?) IN (SELECT value FROM json_each(?))`)
            .run(length, key, system.id, length, JSON.stringify(previous))
          db.prepare('INSERT OR REPLACE INTO derived.meta (key,value) VALUES (?,?)').run(marker, value)
        })()
      }
      this.engineKeys.set(system.id, key)
    }
    const enabled = reg.systems.filter((s) => !this.opts.blockedSystems.has(s.id))
    this.systems = [...enabled.filter((s) => s.demand), ...enabled.filter((s) => !s.demand)]
    const relatedSystems = enabled.filter(s => s.relatedInputs)
    if (relatedSystems.length) db.function('hy_related_digest', { deterministic: true }, relatedDigest)
    for (const s of this.systems) {
      if (s.relatedInputs) this.relations.set(s.id, new RelatedReader(db, reg, s.relatedInputs))
      this.queues.set(s.id, [])
      this.pending.set(s.id, new Set())
      if (s.demand) this.demanded.set(s.id, new Set())
    }

    // 已经不存在的 System 留下的加工记录没有用了；停用的插件保留记录，重新启用时不用全部重算
    db.prepare('DELETE FROM derived.derivation WHERE system NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...reg.systems.map((s) => s.id), ...(opts.retain ?? [])])
    )

    this.record = db.prepare(
      `INSERT INTO derived.derivation (entity_id, system, input_key, plugin_ver, status, error, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_id, system) DO UPDATE SET
         input_key = excluded.input_key, plugin_ver = excluded.plugin_ver, status = excluded.status,
         error = excluded.error, attempts = excluded.attempts, updated_at = excluded.updated_at`
    )
    this.attempts = db.prepare('SELECT input_key, attempts FROM derived.derivation WHERE entity_id = ? AND system = ?')
    this.attachedTo = db
      .prepare("SELECT DISTINCT entity_id FROM main.ref WHERE ref_type = 'attach' AND target_id IN (SELECT value FROM json_each(?))")
      .pluck()
    this.reader = new ProcessingReader(db, reg, store, {
      blockedSystems: opts.blockedSystems, key: (system, id, blocks) => this.key(system, id, blocks), target: blocks => this.targetOf(blocks),
      relatedRevision: (id, blocks) => relatedSystems.flatMap(s => s.has.every(k => blocks[k])
        ? [this.relations.get(s.id)!.rawKey(id)] : []),
      related: (system, id) => this.relations.get(system.id)?.targets(id) ?? [],
      phase: (id, system) => this.jobs.has(jobKey(id, system.id)) ? 'running'
        : this.queues.get(system.id)?.includes(id) || this.demanded.get(system.id)?.has(id) ? 'queued' : undefined
    })
  }

  private readonly attachedTo: Database.Statement

  /** 依附目标：这个身份的数据块里第一个依附引用（局部只有一个）。 */
  private targetOf(blocks: Blocks): string | undefined {
    for (const [kind, b] of Object.entries(blocks)) {
      const def = this.reg.kind(kind)
      if (!def) continue
      for (const [name, f] of Object.entries(def.fields)) {
        if (f.type === 'ref' && f.ref === 'attach' && typeof b.data[name] === 'string') return b.data[name] as string
      }
    }
    return undefined
  }

  /** 这个身份现在的输入键；识别条件不满足时 undefined。 */
  private key(system: RegisteredSystem, id: string, blocks: Blocks): string | undefined {
    const target = system.targetKinds.length ? this.targetOf(blocks) : undefined
    const own = keyOf(system, blocks, target ? this.store.blocksOf(target) : {})
    const related = this.relations.get(system.id)
    return own === undefined ? undefined : own + (related ? '|' + related.key(id) : '') + (this.engineKeys.get(system.id) ?? '')
  }

  // ---------- 外部入口 ----------

  processingStatus(input: ProcessingStatusInput) { return this.reader.read(input) }

  processingSummary(): ProcessingSummary {
    return { running: this.jobs.size, queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0),
      pendingChecks: [...this.pending.values()].reduce((n, ids) => n + ids.size, 0), scanningSystems: this.fullScan.size,
      demanded: [...this.demanded.values()].reduce((n, ids) => n + ids.size, 0) }
  }

  /** 当前自动加工是否还在排队或运行；idle 不保证每种正文都有产出，失败另见 failures。 */
  processing(id: string): 'pending' | 'idle' {
    const busy = this.systems.some(s => this.fullScan.has(s.id) || this.jobs.has(jobKey(id, s.id)) ||
      this.pending.get(s.id)?.has(id) || this.queues.get(s.id)?.includes(id) || this.demanded.get(s.id)?.has(id))
    return busy ? 'pending' : 'idle'
  }

  /** 已接纳的原件换版：立刻退出排队或终止解码，按需消费者继续等新版。 */
  filesChanged(ids: string[]) {
    for (const job of this.jobs.values()) {
      if (job.mediaSeq === undefined || job.abort.signal.aborted || !ids.includes(job.id)) continue
      if (job.mediaSeq === this.store.blocksOf(job.id).file?.seq) continue
      job.retryDemand = true
      job.abort.abort()
    }
  }

  /** 这些身份的数据变了，需要检查。 */
  markDirty(ids: string[]): void {
    // 依附在它们身上的身份：声明了依赖目标的加工也要检查（原文改了，局部要重新找那一句）
    const follows = ids.length > 0 && this.systems.some((s) => !s.demand && s.targetKinds.length)
    const attached = follows ? (this.attachedTo.all(JSON.stringify(ids)) as string[]) : []
    for (const s of this.systems) {
      if (s.demand) continue
      const set = this.pending.get(s.id)!
      for (const id of ids) set.add(id)
      if (s.targetKinds.length) for (const id of attached) set.add(id)
      const related = this.relations.get(s.id)
      if (related) for (const owner of related.affected(ids)) set.add(owner)
    }
    this.kick()
  }

  /** 检查全部身份：启动、安装插件、修改设置时。 */
  rescan(): void {
    for (const s of this.systems) if (!s.demand) this.fullScan.add(s.id)
    this.kick()
  }

  /** 请求按需加工：为这个身份产出某种数据块。返回是否有可用的按需产出者。 */
  demand(id: string, kind: string): boolean {
    const producers = this.reg.producersOf(kind).filter((s) => s.demand && this.demanded.has(s.id))
    for (const s of producers) this.demanded.get(s.id)!.add(id)
    if (producers.length) this.kick()
    return producers.length > 0
  }

  private scheduledIds(): Set<string> {
    const ids = new Set<string>()
    for (const key of this.jobs.keys()) ids.add(key.split('|')[0])
    for (const queue of this.queues.values()) for (const id of queue) ids.add(id)
    for (const demanded of this.demanded.values()) for (const id of demanded) ids.add(id)
    return ids
  }

  /** 成功产物无需验证原件。未出队的待检查身份仍由正常调度处理。 */
  fileAvailabilityCandidates(): Set<string> {
    const ids = this.scheduledIds()
    for (const id of this.interruptedBySpace) ids.add(id)
    for (const id of this.db.prepare("SELECT DISTINCT entity_id FROM derived.derivation WHERE status='failed'").pluck().iterate() as Iterable<string>) ids.add(id)
    return ids
  }

  /** 空间恢复时要能接续被打断的工作，即使尚未产生过失败记录。 */
  cancel(ids: string[], cause: 'removed' | 'unavailable' | 'replaced' = 'removed'): void {
    if (!ids.length) return
    const set = new Set(ids)
    if (cause === 'unavailable') {
      for (const id of this.scheduledIds()) if (set.has(id)) this.interruptedBySpace.add(id)
    } else {
      for (const id of ids) this.interruptedBySpace.delete(id)
    }
    for (const job of this.jobs.values()) if (set.has(job.id)) {
      job.retryDemand = cause === 'replaced'
      job.abort.abort()
    }
    for (const [sid, q] of this.queues) this.queues.set(sid, q.filter((id) => !set.has(id)))
    if (cause !== 'replaced') for (const d of this.demanded.values()) for (const id of ids) d.delete(id)
  }

  setVisible(ids: string[]): void {
    this.visible = ids
    // 排好的队列放回待检查集合，下一次按新的可见范围重新排序
    for (const [sid, q] of this.queues) {
      const set = this.pending.get(sid)!
      const s = this.systems.find((x) => x.id === sid)!
      if (!s.demand && !this.fullScan.has(sid)) for (const id of q) set.add(id)
      this.queues.set(sid, [])
    }
    this.kick()
  }

  /** 清除加工记录，重新生成。 */
  regenerate(ids: string[]): void {
    this.db.prepare('DELETE FROM derived.derivation WHERE entity_id IN (SELECT value FROM json_each(?))').run(
      JSON.stringify(ids)
    )
    this.markDirty(ids)
  }

  /** 重新可用的文件只重试失败加工，不抹掉已完成的加工记录。 */
  retryFailed(ids: string[]): void {
    if (!ids.length) return
    for (const id of ids) this.interruptedBySpace.delete(id)
    this.db.prepare("DELETE FROM derived.derivation WHERE status = 'failed' AND entity_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids))
    this.markDirty(ids)
  }

  private automaticInputs(kinds: string[]) {
    const systems = new Set<string>()
    const visit = (kind: string) => {
      for (const s of this.reg.producersOf(kind)) {
        if (s.demand || this.opts.blockedSystems.has(s.id) || systems.has(s.id)) continue
        systems.add(s.id)
        for (const k of s.has) if (this.reg.kind(k)?.rebuildable) visit(k)
      }
    }
    kinds.forEach(visit)
    return [...systems]
  }

  private inputsBusy(id: string, systems: string[]) {
    return systems.some(sid => this.fullScan.has(sid) || this.jobs.has(jobKey(id, sid)) ||
      this.pending.get(sid)?.has(id) || this.queues.get(sid)?.includes(id))
  }

  /** 等待目标块及其自动上游，用于视图准入预检。 */
  settle(ids: string[], kinds: string[], timeoutMs = 20_000): Promise<void> {
    const systems = this.automaticInputs(kinds)
    const busy = () => ids.some(id => this.inputsBusy(id, systems))
    if (!busy()) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = { done: () => !busy(), resolve }
      this.settleWaiters.push(waiter)
      setTimeout(() => {
        this.settleWaiters = this.settleWaiters.filter((w) => w !== waiter)
        resolve()
      }, timeoutMs)
      this.kick()
    })
  }

  private checkSettled(): void {
    if (!this.settleWaiters.length) return
    this.settleWaiters = this.settleWaiters.filter((w) => {
      if (!w.done()) return true
      w.resolve()
      return false
    })
  }

  /** 等待所有加工完成（测试与基准用）。 */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  stop(): void {
    this.stopped = true
    for (const job of this.jobs.values()) job.abort.abort()
  }

  // ---------- 调度 ----------

  private isIdle(): boolean {
    if (this.jobs.size || this.scheduled || this.fullScan.size) return false
    for (const q of this.queues.values()) if (q.length) return false
    for (const p of this.pending.values()) if (p.size) return false
    for (const d of this.demanded.values()) if (d.size) return false
    return true
  }

  kick(): void {
    if (this.scheduled || this.stopped) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump(): void {
    if (this.stopped) return
    while (this.jobs.size < this.concurrency) {
      const job = this.nextJob()
      if (!job) break
      this.start(job.system, job.id)
    }
    // 自动上游最后一次空扫描也已结束，此刻仍缺输入的请求无法执行。
    if (!this.jobs.size) for (const ids of this.demanded.values()) ids.clear()
    this.checkSettled()
    if (this.jobs.size === 0 && this.isIdle()) {
      this.opts.onProgress?.(0, false)
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    } else {
      this.opts.onProgress?.(this.jobs.size, true)
    }
  }

  private nextJob(): { system: RegisteredSystem; id: string } | undefined {
    for (const system of this.systems) {
      if ((this.runningBy.get(system.id) ?? 0) >= (system.concurrency ?? Infinity)) continue
      let q = this.queues.get(system.id)!
      for (;;) {
        while (q.length) {
          const id = q.shift()!
          if (!this.jobs.has(jobKey(id, system.id))) return { system, id }
        }
        // 队列空了：还有没检查的身份就再查一次，直到确实没有工作
        if (!this.hasUnchecked(system)) break
        q = this.findWork(system)
        this.queues.set(system.id, q)
        if (q.length === 0) break
      }
    }
    return undefined
  }

  private hasUnchecked(system: RegisteredSystem): boolean {
    if (system.demand) return this.demanded.get(system.id)!.size > 0
    return this.fullScan.has(system.id) || this.pending.get(system.id)!.size > 0
  }

  /** 识别条件满足、且加工记录缺失或过期的身份。可见的优先，新的优先。 */
  private findWork(system: RegisteredSystem): string[] {
    let restrict: Set<string> | undefined
    let limit: number | undefined
    if (system.demand) {
      restrict = this.demanded.get(system.id)!
      if (restrict.size === 0) return []
    } else if (this.fullScan.has(system.id)) {
      limit = BATCH + this.jobs.size
    } else {
      restrict = this.pending.get(system.id)!
      if (restrict.size === 0) return []
    }

    const params: Record<string, unknown> = { system: system.id, ver: system.pluginVersion, visible: JSON.stringify(this.visible) }
    let parameter = 0
    const bind = (value: string) => {
      const name = 'input' + parameter++
      params[name] = value
      return '@' + name
    }
    const joins = system.has.map(
      (kind, i) => `JOIN ${this.reg.schemaOf(kind)}.block b${i} ON b${i}.entity_id = e.id AND b${i}.kind = ${bind(kind)}`
    )
    // 新鲜度键与 keyOf 一致。字段名按字面量处理，包括带点的字段。
    const part = ({ spec, field }: RegisteredSystem['inputKinds'][number], alias: string) => {
      if (!field) return `${bind(spec + ':')} || ${alias}.seq`
      const path = bind('$.' + JSON.stringify(field))
      return `${bind(spec + '=')} || COALESCE(json_extract(${alias}.data, ${path}), '')`
    }
    const keyParts = system.inputKinds.map(input => part(input, `b${system.has.indexOf(input.kind)}`))
    const ownKey = keyParts.length ? keyParts.join(` || ',' || `) : `''`
    const targetParts = system.targetKinds.map(input => {
      const { kind } = input
      const missing = bind(input.spec + (input.field ? '=' : ':'))
      return `'>' || COALESCE((SELECT ${part(input, 'tb')} FROM main.ref r JOIN ${this.reg.schemaOf(kind)}.block tb ON tb.entity_id = r.target_id AND tb.kind = ${bind(kind)} WHERE r.entity_id = e.id AND r.ref_type = 'attach' LIMIT 1), ${missing})`
    })
    const related = this.relations.get(system.id)
    if (related) targetParts.push(`'|' || ${related.sqlKey}`)
    const engine = (this.engineKeys.get(system.id) ?? '')
    if (engine) targetParts.push('@engine')
    const inputKey = [`(${ownKey})`, ...targetParts].join(' || ')

    const sql = `
      SELECT e.id FROM main.entity e
      ${joins.join('\n')}
      LEFT JOIN derived.derivation d ON d.entity_id = e.id AND d.system = @system
      WHERE e.deleted_at IS NULL ${restrict ? 'AND e.id IN (SELECT value FROM json_each(@restrict))' : ''}
        AND (d.entity_id IS NULL OR d.plugin_ver != @ver OR d.input_key != ${inputKey})
      ORDER BY CASE WHEN e.id IN (SELECT value FROM json_each(@visible)) THEN 0 ELSE 1 END, e.created_at DESC
      ${limit ? `LIMIT ${limit}` : ''}`
    if (engine) params.engine = engine
    if (restrict) params.restrict = JSON.stringify([...restrict])
    const ids = this.db.prepare(sql).pluck().all(params) as string[]

    if (system.demand) {
      // 已经是最新的请求直接完成；需要做的留到运行结束
      const set = this.demanded.get(system.id)!
      const need = new Set(ids)
      for (const id of set) if (!need.has(id)) {
        // 换版会先撤去旧的派生块。上游仍有工作时保留请求，等新版输入就绪。
        const blocks = this.store.blocksOf(id)
        const missing = system.has.filter(kind => !blocks[kind] && this.reg.kind(kind)?.rebuildable)
        if (!this.inputsBusy(id, this.automaticInputs(missing))) set.delete(id)
      }
    } else if (limit !== undefined) {
      // 全量扫描做完了：它同时覆盖了待检查集合里的身份
      if (ids.length < limit) {
        this.fullScan.delete(system.id)
        this.pending.get(system.id)!.clear()
      }
    } else {
      restrict!.clear()
    }
    return ids.filter((id) => !this.jobs.has(jobKey(id, system.id)))
  }

  private start(system: RegisteredSystem, id: string): void {
    const key = jobKey(id, system.id)
    const abort = new AbortController()
    const job: RunningJob = { id, abort }
    this.jobs.set(key, job)
    this.runningBy.set(system.id, (this.runningBy.get(system.id) ?? 0) + 1)
    this.runJob(system, job)
      .catch((e): JobOutcome => {
        console.error(`[scheduler] ${system.id} ${id}`, e)
        return 'failed'
      })
      .then(phase => {
        this.jobs.delete(key)
        this.runningBy.set(system.id, this.runningBy.get(system.id)! - 1)
        if (!job.retryDemand) this.demanded.get(system.id)?.delete(id)
        // 库已经关了（停下时还在跑的加工这时才结束）：不再碰数据库
        if (!this.stopped) {
          // 常规后台导入仍合并通知。只为按需任务或主动上报进度的任务发单项终态。
          if (system.demand || job.progress !== undefined) {
            const progress = phase === 'done' || phase === 'empty' ? 1 : job.progress ?? 0
            this.opts.onJob?.({ id, system: system.id, phase: phase ?? 'cancelled', progress })
          }
          this.markDirty([id])
        }
      })
  }

  private async runJob(system: RegisteredSystem, job: RunningJob): Promise<JobOutcome | undefined> {
    const { id } = job
    const signal = job.abort.signal
    const blocks = this.store.blocksOf(id)
    const inputKey = this.key(system, id, blocks)
    if (inputKey === undefined) return // 识别条件已不满足
    const target = this.targetOf(blocks), targetBlocks = target ? this.store.blocksOf(target) : {}
    const fileSeq = blocks.file?.seq, fileRef = blocks.file?.data.path
    const readsFile = system.has.includes('file'), readsTargetFile = system.targetKinds.some(input => input.kind === 'file')
    const stillCurrent = () => {
      if (!this.store.exists(id) || this.store.isTrashed(id)) return false
      const current = this.store.blocksOf(id)
      // 哈希可能 A→B→A；期间的原件读取仍会失效。序号用于在途检查，不改变稳定加工键。
      return this.key(system, id, current) === inputKey && (!readsFile || current.file?.seq === fileSeq) &&
        (!readsTargetFile || (target ? this.store.blocksOf(target).file?.seq : undefined) === targetBlocks.file?.seq)
    }

    if (system.match && !system.match(blocks)) {
      this.write(id, system, inputKey, 'skipped', null, 0)
      return 'skipped'
    }

    // 仲裁：同一种数据块有多个产出者时，这个身份上只有一个写入者
    const owned = system.outputs.filter((k) => this.reg.authorityFor(k, blocks, this.opts.blockedSystems) === system)
    if (owned.length === 0) {
      const other = this.reg.authorityFor(system.outputs[0], blocks, this.opts.blockedSystems)
      this.write(id, system, inputKey, 'skipped', `由 ${other?.id ?? '其他插件'} 负责`, 0)
      return 'skipped'
    }

    const originalRefs = new Set([blocks.file?.data.path, targetBlocks.file?.data.path].filter((ref): ref is string => typeof ref === 'string'))
    const related = this.relations.get(system.id)?.snapshot(id)
    if (related) for (const source of related.sources.values()) {
      if (typeof source.file?.data.path === 'string') originalRefs.add(source.file.data.path)
    }
    const readRefs = new Set<string>()
    let staged: { path: string; bytes: Buffer } | undefined, composing = false
    // 只为实际消费能力的加工创建调用会话。结束后旧上下文不能再取原件。
    let calls: JobContext['capabilities'] | undefined
    let lifetime: AbortController | undefined
    let finished = false
    const getCapabilities = () => {
      if (finished) throw Error('[CAPABILITY_EXPIRED] 加工已结束')
      if (calls) return calls
      lifetime = new AbortController()
      calls = this.opts.capabilities.forJob(system.plugin, source => {
        const linked = related?.sources.get(source.id)?.file
        const own = readsFile && source.id === id && source.fileSeq === fileSeq
        if ((!own && (!linked || source.fileSeq !== linked.seq)) || !stillCurrent()) {
          throw Error('[CAPABILITY_SOURCE_CHANGED] 素材不属于本次加工或已换版')
        }
        const ref = own ? fileRef : linked?.data.path
        if (typeof ref !== 'string') throw Error('[FILE_UNAVAILABLE] 缺少原件')
        if (own) job.mediaSeq = fileSeq
        readRefs.add(ref)
        return this.ctx.abs(ref)
      }, AbortSignal.any([signal, lifetime.signal]), {
        progress: fraction => ctx.progress(fraction),
        allowed: this.opts.capabilities.systemCapabilities(system.plugin, system),
        priority: system.demand ? 'interactive' : 'background',
        stage: async (format, bytes, maxEdge) => {
          if (composing || finished) throw Error('[CAPABILITY_ARTIFACT_LIMIT] 一次加工只可提交一份文件产物')
          composing = true
          const artifact = await stageImageArtifact(system.id, id, bytes, format, maxEdge)
          if (finished) throw Error('[CAPABILITY_EXPIRED] 加工已结束')
          staged = artifact
          return { path: artifact.path, source: artifact.source }
        }
      })
      return calls
    }
    const ctx: JobContext = {
      ...this.ctx,
      get capabilities() { return getCapabilities() },
      related,
      abs: ref => {
        const path = this.ctx.abs(ref)
        if (originalRefs.has(ref)) readRefs.add(ref)
        return path
      },
      signal,
      composeImage: async image => {
        if (composing) throw Error('一次加工只能合成一张图')
        composing = true
        const { bytes, source } = await renderJobImage(image, ctx.abs, signal)
        const name = createHash('sha256').update(JSON.stringify([system.id, id])).digest('hex')
        const path = `cache/composites/${name}.webp`
        staged = { path, bytes }
        return { path, source }
      },
      progress: fraction => {
        if (finished || signal.aborted || !Number.isFinite(fraction)) return
        job.progress = Math.max(0, Math.min(1, fraction))
        this.opts.onJob?.({ id, system: system.id, phase: 'progress', progress: job.progress })
      }
    }
    let out: Awaited<ReturnType<RegisteredSystem['run']>>
    try {
      out = await system.run(ctx, id, blocks)
      if (signal.aborted || !stillCurrent()) return
      // 只检查本次确实定位读取的原件；纯数据块运算不应因原件离线而失败。
      for (const ref of readRefs) this.opts.validateFile?.(ref)
    } catch (e) {
      if (signal.aborted || !stillCurrent()) return // 过期读取错误不污染新输入的加工记录
      this.fail(id, system, inputKey, e)
      return 'failed'
    } finally {
      finished = true
      lifetime?.abort()
    }
    if (signal.aborted) return

    // 运行期间输入可能又变了：结果作废，留给下一轮
    if (!stillCurrent()) return

    try {
      this.store.batch(() => {
        let publish = false
        for (const kind of owned) {
          const data = out[kind]
          if (data === null) this.clearOutput(id, kind)
          else if (data !== undefined) {
            this.store.put(id, kind, data, false, system.plugin)
            if (staged && Object.entries(this.reg.requireKind(kind).fields).some(([key, f]) => {
              const value = data[key]
              return f.file && (f.list && Array.isArray(value) ? value.includes(staged!.path) : value === staged!.path)
            })) publish = true
          }
        }
        this.write(id, system, inputKey, 'ok', null, 0)
        if (staged && publish) {
          if (!this.opts.writeCache) throw Error('加工缓存不可写')
          this.opts.writeCache(staged.path, staged.bytes)
        }
      })
      return owned.some(k => out[k] === undefined ? !!blocks[k] : out[k] !== null) ? 'done' : 'empty'
    } catch (e) {
      this.fail(id, system, inputKey, e)
      return 'failed'
    }
  }

  /** 上游显式撤下产物时，一并撤下已失去必要输入的派生结果（例如代表图的缩略图）。 */
  private clearOutput(id: string, kind: string): void {
    const blocks = this.store.blocksOf(id)
    if (!blocks[kind]) return
    this.store.remove(id, kind)
    const remaining = { ...blocks }
    delete remaining[kind]
    for (const consumer of this.systems) {
      if (!consumer.has.includes(kind)) continue
      for (const output of consumer.outputs) {
        if (!blocks[output] || this.reg.authorityFor(output, blocks, this.opts.blockedSystems) !== consumer) continue
        const replacement = this.reg.authorityFor(output, remaining, this.opts.blockedSystems)
        // 输入按指定字段取键时，撤下后恢复原值仍须重建；备用产出者也可能留有 skipped 回执。
        this.db.prepare('DELETE FROM derived.derivation WHERE entity_id=? AND system=?').run(id, consumer.id)
        if (replacement) this.db.prepare('DELETE FROM derived.derivation WHERE entity_id=? AND system=?').run(id, replacement.id)
        else this.clearOutput(id, output)
      }
    }
  }

  private fail(id: string, system: RegisteredSystem, inputKey: string, error: unknown): void {
    const prev = this.attempts.get(id, system.id) as { input_key: string; attempts: number } | undefined
    const attempts = prev?.input_key === inputKey ? prev.attempts + 1 : 1
    this.write(id, system, inputKey, 'failed', error instanceof Error ? error.message : String(error), attempts)
  }

  private write(id: string, system: RegisteredSystem, inputKey: string, status: string, error: string | null, attempts: number): void {
    this.record.run(id, system.id, inputKey, system.pluginVersion, status, error, attempts, Date.now())
  }
}

/** 与 findWork 中 SQL 拼出的 input_key 完全一致。识别条件不满足时返回 undefined。target：依附目标的数据块。 */
function keyOf(system: RegisteredSystem, blocks: Blocks, target: Blocks = {}): string | undefined {
  if (!system.has.every((k) => blocks[k])) return undefined
  const part = ({ kind, field, spec }: RegisteredSystem['inputKinds'][number], from: Blocks) => {
    const b = from[kind]
    if (!field) return `${spec}:${b?.seq ?? ''}`
    const v = b?.data[field]
    // 与 SQLite json_extract 的文本拼接一致：列表/对象为 JSON，布尔为 0/1。
    const value = v == null ? '' : typeof v === 'boolean' ? Number(v) : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return `${spec}=${value}`
  }
  const own = system.inputKinds.map((k) => part(k, blocks)).join(',')
  return own + system.targetKinds.map((k) => `>${part(k, target)}`).join('')
}
