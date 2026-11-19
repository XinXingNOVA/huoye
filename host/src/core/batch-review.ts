import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { batchReviewSchema, type BatchReviewInput, type ReviewList, type ReviewPage, type ReviewSource, type ReviewSummary } from '../shared/batch-review'
import { summaryTitle } from '../shared/title'
import type { BlockData, BlockKind } from '../shared/blocks'
import { batchReviewSessionSql } from './batch-review-schema'
import { reviewableBlock } from './review-command'
import { retiredSignature } from './task-retention'
import type { History } from './history'
import type { Registry } from './registry'
import type { Store } from './store'

type Sheet = { id: string; title: string; state: ReviewSummary['state']; requests: string; unchanged: string; created: number; decided_by: ReviewSource | null; decided_at: number | null }
type Delta = { entity_id: string; kind: string; field: string; member: string; title: string; prior: string; final: string; position: number; template_seq: number | null; kind_version: number | null; touched: number }
type WithdrawnItem = { entity_id: string; decided_by: ReviewSource; decided_at: number }
type Write = { op: number; seq: number; entity_id: string; kind: string; data: string | null; new_data: string | null }
const readData = (data: string | null): BlockData | null => data === null ? null : JSON.parse(data)
const json = (value: unknown) => JSON.stringify(value ?? null)
// 这里读取的都是不可变的 JSON 快照。同一长列表的各成员共用一次计数。
const memberCounts = new WeakMap<unknown[], Map<string, number>>()
function valueOf(data: BlockData | null, field: string, member: string) {
  if (!field) return data !== null
  if (member) {
    const values = data?.[field]
    if (!Array.isArray(values)) return false
    let counts = memberCounts.get(values)
    if (!counts) {
      counts = new Map<string, number>()
      for (const value of values) if (typeof value === 'string') counts.set(value, (counts.get(value) ?? 0) + 1)
      memberCounts.set(values, counts)
    }
    const count = counts.get(member) ?? 0
    return count > 1 ? count : count === 1
  }
  return data?.[field] ?? null
}

// 显式空数组、重复或非字符串列表保留整个字段，避免成员差异丢失信息。
function memberList(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !v) || new Set(value).size !== value.length) return undefined
  return value
}

function reordered(before: unknown, after: unknown): boolean {
  if (Array.isArray(after) && !after.length) return !Array.isArray(before) || before.length > 0
  if (!Array.isArray(before) || !Array.isArray(after)) return false
  const left = new Set(before), right = new Set(after)
  return json(before.filter(v => right.has(v))) !== json(after.filter(v => left.has(v)))
}

export class BatchReviews {
  constructor(private db: Database.Database, private store: Store, private reg: Registry, private history: History, private changed: () => void) {
    db.exec(batchReviewSessionSql)
  }

  private templateSeq(def: BlockKind) {
    if (!def.template) return null
    const source = this.reg.definers().find(d => d.plugin === def.plugin)
    return source ? this.store.blocksOf(def.template, [source.kind])[source.kind]?.seq ?? -1 : -1
  }

  run(raw: BatchReviewInput, source: ReviewSource): ReviewPage | ReviewList {
    const input = batchReviewSchema.parse(raw)
    if (input.action === 'list') {
      const rows = this.db.prepare("SELECT * FROM main.review_sheet WHERE state<>'draft' ORDER BY created DESC, id LIMIT ? OFFSET ?").all(input.limit + 1, input.offset) as Sheet[]
      return { batches: rows.slice(0, input.limit).map(row => this.summary(row)), nextOffset: rows.length > input.limit ? input.offset + input.limit : null }
    }
    if (input.action === 'get') return this.page(input.batchId, input.offset, input.limit)
    return this.store.batch(() => {
      const id = input.action === 'create' ? this.create(input.title, input.requestIds) : input.batchId
      if (input.action !== 'create') this.decide(id, input.action, source, input.action === 'withdraw' ? input.ids : undefined)
      return this.page(id, 0, 20)
    })
  }

  private sheet(id: string) {
    const row = this.db.prepare("SELECT * FROM main.review_sheet WHERE id=? AND state<>'draft'").get(id) as Sheet | undefined
    if (!row) throw new Error('[REVIEW_UNAVAILABLE] 本库没有这张验收单，或相关记录已清理')
    return row
  }

  private summary(row: Sheet): ReviewSummary {
    const counts = this.db.prepare('SELECT count(DISTINCT entity_id) items, count(CASE WHEN position>=0 THEN 1 END) changes, coalesce(sum(CASE WHEN position>=0 THEN touched END),0) preserved FROM main.review_delta WHERE batch=?').get(row.id) as Pick<ReviewSummary, 'items' | 'changes' | 'preserved'>
    return { id: row.id, title: row.title, state: row.state, requests: JSON.parse(row.requests), unchangedRequests: JSON.parse(row.unchanged), created: row.created,
      decidedAt: row.decided_at, decidedBy: row.decided_by, ...counts, withdrawnItems: Number(this.db.prepare('SELECT count(*) FROM main.review_withdrawn WHERE batch=?').pluck().get(row.id)) }
  }

  private page(id: string, offset: number, limit: number): ReviewPage {
    const batch = this.summary(this.sheet(id))
    return { batch, ...this.changes(id, offset, limit, batch.items, batch.state === 'pending') }
  }

  draft(task: string, request: string, offset: number, limit: number) {
    const row = this.db.prepare(`SELECT s.id FROM main.task_write w JOIN main.review_sheet s ON s.id=w.sheet
      WHERE w.task=? AND w.request=? AND s.state='draft'`).get(task, request) as { id: string } | undefined
    if (!row) throw new Error('[REVIEW_UNAVAILABLE] 这项任务没有该待送审草稿，请重新查看 writes')
    const total = Number(this.db.prepare('SELECT count(DISTINCT entity_id) FROM main.review_delta WHERE batch=?').pluck().get(row.id))
    return this.changes(row.id, offset, limit, total, true)
  }

  private changes(id: string, offset: number, limit: number, total: number, trackChanges: boolean) {
    const ids = this.db.prepare('SELECT DISTINCT entity_id FROM main.review_delta WHERE batch=? ORDER BY entity_id LIMIT ? OFFSET ?').pluck().all(id, limit, offset) as string[]
    const read = this.db.prepare('SELECT * FROM main.review_delta WHERE batch=? AND entity_id=? ORDER BY kind, field, position, member')
    const decisions = this.db.prepare('SELECT * FROM main.review_withdrawn WHERE batch=? AND entity_id IN (SELECT value FROM json_each(?))').all(id, json(ids)) as WithdrawnItem[]
    const withdrawn = new Map(decisions.map(d => [d.entity_id, d]))
    const titles = new Map<string, string | undefined>()
    const items = ids.map(entity => {
      const rows = read.all(id, entity) as Delta[]
      const blocks = this.store.blocksOf(entity, [...new Set(rows.map(d => d.kind))])
      const available = new Map<string, boolean>()
      const changes = rows.filter(d => d.position >= 0).map(d => {
        if (trackChanges && !withdrawn.has(entity) && !available.has(d.kind)) available.set(d.kind, this.available(d))
        const preserved = !!d.touched || available.get(d.kind) === false
        const current = preserved ? valueOf(blocks[d.kind]?.data ?? null, d.field, d.member) : undefined
        const compact = current === undefined || typeof current === 'boolean' || typeof current === 'number' || current === null
          ? current : (typeof current === 'string' ? current : JSON.stringify(current))
        const currentPreview = typeof compact === 'string' && compact.length > 256 ? compact.slice(0, 256) + '…' : compact
        const field = this.reg.kind(d.kind)?.fields[d.field], before = JSON.parse(d.prior), after = JSON.parse(d.final)
        const referenceTitles: Record<string, string> = Object.create(null)
        if (field?.type === 'ref') {
          for (const ref of d.member ? [d.member] : [before, after].flat()) {
            if (typeof ref !== 'string') continue
            if (!titles.has(ref) && titles.size < 200) {
              titles.set(ref, this.store.exists(ref) ? summaryTitle(this.store.blocksOf(ref), k => this.reg.kind(k), ref) : undefined)
            }
            const title = titles.get(ref)
            if (title) referenceTitles[ref] = title
          }
        }
        return { kind: d.kind, field: d.field, title: d.title, member: d.member, before, after, format: field?.format,
          ...(Object.keys(referenceTitles).length ? { referenceTitles } : {}),
          preserved, ...(preserved ? { currentPreview } : {}) }
      })
      const decision = withdrawn.get(entity)
      return { id: entity, withdrawn: !!decision, ...(decision && { withdrawnBy: decision.decided_by, withdrawnAt: decision.decided_at }), changes }
    })
    return { items, nextOffset: offset + ids.length < total ? offset + ids.length : null }
  }

  private available(d: Delta) {
    const def = this.reg.kind(d.kind)
    if (!def || def.dormant || !this.store.exists(d.entity_id) || this.store.isTrashed(d.entity_id)) return false
    if (!reviewableBlock(def) || (d.kind_version !== null && def.version !== d.kind_version)) return false
    return !def.template || (d.template_seq !== -1 && this.templateSeq(def) === d.template_seq)
  }

  // 与命令、历史和幂等回执共用外层事务。此刻无历史行表示刚执行的命令没有净写入。
  capture(task: string, request: string, operation: string, reviewable: boolean) {
    const sheet = this.create(operation, [request], { reviewable })
    this.db.prepare('INSERT INTO main.task_write VALUES (?,?,?,?)').run(request, task, operation, sheet)
  }

  private ensureRoom() {
    if (Number(this.db.prepare("SELECT count(*) FROM main.review_sheet WHERE state='pending'").pluck().get()) >= 64)
      throw new Error('[REVIEW_LIMIT] 已有 64 张待验收单，请先处理已有批次')
  }

  private submitDrafts(title: string, params: string, signature: string, count: number): string | undefined {
    const drafts = this.db.prepare(`SELECT w.task,w.sheet,w.request,s.state,s.unchanged FROM main.task_write w
      LEFT JOIN main.review_sheet s ON s.id=w.sheet WHERE w.request IN (SELECT value FROM json_each(?))`).all(params) as
      {task: string; sheet: string; request: string; state: string | null; unchanged: string}[]
    if (!drafts.length) return undefined
    if (drafts.some(d => !d.state)) throw new Error('[REVIEW_UNAVAILABLE] 相关任务差异已清理')
    if (drafts.some(d => d.state !== 'draft')) throw new Error('[REVIEW_OVERLAP] 有请求已经送审，请读取原验收单')
    if (drafts.length !== count || drafts.some(d => d.task !== drafts[0].task)) throw new Error('[REVIEW_MIXED] 请将同一任务的草稿一起送审，普通操作另行建单')
    this.ensureRoom()
    if (drafts.length === 1) {
      this.db.prepare("UPDATE main.review_sheet SET state='pending',title=? WHERE id=?").run(title,drafts[0].sheet)
      return drafts[0].sheet
    }
    const sheets = json(drafts.map(d => d.sheet)), selected = 'batch IN (SELECT value FROM json_each(?))'
    if (this.db.prepare(`SELECT 1 FROM main.review_delta WHERE ${selected} GROUP BY entity_id,kind,field
      HAVING count(DISTINCT batch)>1 AND (count(*)>count(DISTINCT member) OR min(member)='') LIMIT 1`).get(sheets))
      throw new Error('[REVIEW_INTERLEAVED] 草稿涉及同一项的同一字段或列表成员，请分别送审以保留各次修改')
    const size = this.db.prepare(`SELECT count(CASE WHEN position>=0 THEN 1 END) n,sum(length(CAST(prior AS BLOB))+length(CAST(final AS BLOB))+length(CAST(member AS BLOB))) bytes FROM main.review_delta WHERE ${selected}`).get(sheets) as {n:number;bytes:number|null}
    if (size.n > 2000 || (size.bytes ?? 0) > 512*1024) throw new Error('[REVIEW_LIMIT] 合并后的差异过大，请分批送审')
    const id = randomUUID(), unchanged = drafts.filter(d => JSON.parse(d.unchanged).length).map(d => d.request).sort()
    this.db.prepare("INSERT INTO main.review_sheet VALUES (?,?,?,?,?,'pending',?,NULL,NULL)").run(id,title,signature,params,json(unchanged),Date.now())
    this.db.prepare(`UPDATE main.review_delta SET batch=? WHERE ${selected}`).run(id,sheets)
    this.db.prepare('UPDATE main.task_write SET sheet=? WHERE sheet IN (SELECT value FROM json_each(?))').run(id,sheets)
    this.db.prepare('DELETE FROM main.review_sheet WHERE id IN (SELECT value FROM json_each(?))').run(sheets)
    return id
  }

  private create(title: string, requests: string[], capture?: {reviewable:boolean}): string {
    const ids = [...new Set(requests)].sort(), signature = createHash('sha256').update(json(ids)).digest('hex')
    const existing = this.db.prepare("SELECT id FROM main.review_sheet WHERE signature=? AND state<>'draft'").pluck().get(signature) as string | undefined
    if (existing) return existing
    const params = json(ids)
    if (!capture) {
      if (this.db.prepare('SELECT 1 FROM main.operation_receipt WHERE signature=? AND request_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(retiredSignature, params))
        throw new Error('[REVIEW_UNAVAILABLE] 相关任务明细已清理')
      const submitted = this.submitDrafts(title, params, signature, ids.length)
      if (submitted) {
        this.store.afterCommit(this.changed)
        return submitted
      }
    }
    if (this.db.prepare('SELECT 1 FROM main.review_sheet, json_each(requests) WHERE value IN (SELECT value FROM json_each(?)) LIMIT 1').get(params))
      throw new Error('[REVIEW_OVERLAP] 有请求已属于其他验收单，请按原批次查询')
    const ops = this.db.prepare(`SELECT id, state, json_extract(context,'$.reviewable') reviewable,
      json_extract(context,'$.partial') partial, json_extract(context,'$.requestId') request FROM main.operation WHERE session=? AND json_extract(context,'$.source')='external'
      AND json_extract(context,'$.requestId') IN (SELECT value FROM json_each(?)) ORDER BY id`).all(this.history.session, params) as { id: number; state: string; partial: number | null; reviewable: number; request: string }[]
    const byRequest = new Map(ops.map(op => [op.request, op]))
    const unchanged: string[] = []
    for (const request of ids) {
      const op = byRequest.get(request)
      const context = op ?? capture ?? this.history.unchangedRequest(request)
      if (!context || (op && (op.state !== 'done' || op.partial)))
        throw new Error(`[REVIEW_HISTORY_UNAVAILABLE] 请求 ${request} 的当前会话历史不可用，请核对是否已撤销、重载或清理`)
      if (!context.reviewable) throw new Error('[REVIEW_UNSUPPORTED] 请求涉及结构、身份或缺少可撤回历史的数据')
      if (!op) unchanged.push(request)
    }
    const selected = json(ops.map(op => op.id))
    if (this.db.prepare(`SELECT 1 FROM main.op_entity WHERE op IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM main.record_history WHERE op IN (SELECT value FROM json_each(?)) LIMIT 1`).get(selected, selected))
      throw new Error('[REVIEW_UNSUPPORTED] 此请求还改变了身份或管理记录')
    const writes = this.db.prepare('SELECT * FROM main.block_history WHERE op IN (SELECT value FROM json_each(?)) ORDER BY entity_id,kind,seq').iterate(selected) as Iterable<Write>
    const groups = new Map<string, Write[]>()
    let bytes = 0
    for (const row of writes) {
      if (!reviewableBlock(this.reg.kind(row.kind))) throw new Error('[REVIEW_UNSUPPORTED] 缺少可单独撤回的业务块定义：' + row.kind)
      bytes += Buffer.byteLength(row.data ?? '') + Buffer.byteLength(row.new_data ?? '')
      if (bytes > 512 * 1024) throw new Error('[REVIEW_LIMIT] 历史值超过 512 KiB，请减少本批请求')
      const key = json([row.entity_id, row.kind])
      const group = groups.get(key)
      if (group) group.push(row)
      else groups.set(key, [row])
    }
    const id = randomUUID()
    if (!capture) this.ensureRoom()
    this.db.prepare('INSERT INTO main.review_sheet VALUES (?,?,?,?,?,?,?,NULL,NULL)').run(id,title,signature,params,json(unchanged),capture ? 'draft' : 'pending',Date.now())
    const insert = this.db.prepare(`INSERT INTO main.review_delta
      (batch,entity_id,kind,field,member,title,prior,final,position,template_seq,touched,kind_version)
      VALUES (@batch,@entity_id,@kind,@field,@member,@title,@prior,@final,@position,@template_seq,@touched,@kind_version)`)
    let count = 0
    for (const group of groups.values()) {
      const deltas = this.deltas(group, 2000 - count)
      count += deltas.filter(d => d.position >= 0).length
      for (const d of deltas) insert.run({ batch: id, ...d })
    }
    if (!capture) this.store.afterCommit(this.changed)
    return id
  }

  private deltas(rows: Write[], remaining: number): Delta[] {
    const first = rows[0], last = rows[rows.length - 1], entity = first.entity_id, kind = first.kind
    const def = this.reg.requireKind(kind), before = readData(first.data), after = readData(last.new_data)
    const intervening = this.db.prepare('SELECT count(*) FROM main.block_history WHERE entity_id=? AND kind=? AND seq BETWEEN ? AND ?').pluck().get(entity, kind, first.seq, last.seq)
    if (intervening !== rows.length || rows.some((r, i) => i > 0 && rows[i - 1].new_data !== r.data))
      throw new Error('[REVIEW_INTERLEAVED] 同一素材数据块中夹有其他操作，请分开提交')
    const current = this.store.blocksOf(entity, [kind])[kind]
    const templateSeq = this.templateSeq(def)
    const tail = this.db.prepare('SELECT count(*) count, sum(coalesce(length(CAST(data AS BLOB)),0)+coalesce(length(CAST(new_data AS BLOB)),0)) bytes FROM main.block_history WHERE entity_id=? AND kind=? AND seq>?').get(entity, kind, last.seq) as { count: number; bytes: number | null }
    const bounded = tail.count <= 100 && (tail.bytes ?? 0) <= 512 * 1024
    const later = bounded ? this.db.prepare('SELECT data,new_data,seq FROM main.block_history WHERE entity_id=? AND kind=? AND seq>? ORDER BY seq').all(entity, kind, last.seq) as Write[] : []
    const latest = later.at(-1) ?? last
    const unlogged = Number(this.db.prepare('SELECT seq FROM temp.review_unlogged WHERE entity_id=? AND kind=?').pluck().get(entity, kind) ?? 0)
    if (unlogged > first.seq && unlogged < last.seq) throw new Error('[REVIEW_INTERLEAVED] 两笔写入之间发生过历史回放，请分开提交')
    const traceable = bounded && unlogged < first.seq && (current ? current.seq === latest.seq : latest.new_data === null)
    const laterData = later.map(r => [readData(r.data), readData(r.new_data)] as const)
    const result: Delta[] = [], changedOrder = new Set<string>()
    const add = (field: string, member: string, title: string, position = 0) => {
      const prior = json(valueOf(before, field, member)), final = json(valueOf(after, field, member))
      if (prior === final) return
      if (position >= 0 && result.length >= remaining) throw new Error('[REVIEW_LIMIT] 单批最多 2000 处变化，请拆批')
      const touched = !traceable || (!!member && changedOrder.has(field)) || (!field && later.length > 0) || (templateSeq !== null && templateSeq > last.seq)
        || final !== json(valueOf(current?.data ?? null, field, member))
        || laterData.some(([a,b]) => b === null || json(valueOf(a, field, member)) !== json(valueOf(b, field, member)))
      result.push({ entity_id: entity, kind, field, member, title, position, prior, final, touched: Number(touched), template_seq: templateSeq, kind_version: def.version })
    }
    for (const field of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      const meta = def.fields[field]
      if (!meta) throw new Error('[REVIEW_UNSUPPORTED] 历史字段缺少定义：' + field)
      const members = meta.list && meta.type !== 'json'
      const old = members && memberList(before?.[field]), next = members && memberList(after?.[field])
      if (old && next) {
        const oldSet = new Set(old), nextSet = new Set(next)
        if (json(old.filter(v => nextSet.has(v))) === json(next.filter(v => oldSet.has(v)))) {
          if (laterData.some(([a,b]) => reordered(a?.[field], b?.[field]))) changedOrder.add(field)
          old.forEach((v, i) => { if (!nextSet.has(v)) add(field, v, meta.title, i) })
          next.forEach((v, i) => { if (!oldSet.has(v)) add(field, v, meta.title, i) })
          continue
        }
      }
      add(field, '', meta.title)
    }
    // 普通附加块的存在性随具体字段一起回放；只有空块、模板成员才需要额外显示一行。
    add('', '', def.title, result.length && !def.template ? -1 : 0)
    return result
  }

  private decide(id: string, action: 'confirm' | 'withdraw', source: ReviewSource, ids?: string[]) {
    const sheet = this.sheet(id), at = Date.now()
    if (ids) {
      const selected = new Set(ids)
      const members = this.db.prepare('SELECT DISTINCT entity_id FROM main.review_delta WHERE batch=? AND entity_id IN (SELECT value FROM json_each(?))').pluck().all(id, json(ids))
      if (members.length !== selected.size) throw new Error('[INVALID_INPUT] 所选素材不全在这张验收单中')
      const decided = this.db.prepare('SELECT entity_id FROM main.review_withdrawn WHERE batch=? AND entity_id IN (SELECT value FROM json_each(?))').pluck().all(id, json(ids))
      if (decided.length === selected.size) return
    }
    if (sheet.state === (action === 'confirm' ? 'confirmed' : 'withdrawn')) return
    if (sheet.state !== 'pending') throw new Error('[REVIEW_DECIDED] 这张验收单已有其他结论')
    let complete = true
    if (action === 'withdraw') {
      const rows = this.db.prepare(`SELECT d.* FROM main.review_delta d WHERE batch=?
        AND NOT EXISTS (SELECT 1 FROM main.review_withdrawn w WHERE w.batch=d.batch AND w.entity_id=d.entity_id)
        AND (? IS NULL OR entity_id IN (SELECT value FROM json_each(?)))
        ORDER BY entity_id,kind,field,position`).all(id, ids ? 1 : null, json(ids)) as Delta[]
      const mark = this.db.prepare('INSERT INTO main.review_withdrawn VALUES (?,?,?,?)')
      for (const entity of new Set(rows.map(d => d.entity_id))) mark.run(id, entity, source, at)
      const blocks = new Map<string, Delta[]>()
      for (const d of rows) {
        const key = json([d.entity_id, d.kind])
        const group = blocks.get(key)
        if (group) group.push(d)
        else blocks.set(key, [d])
      }
      this.history.run(ids ? `撤回「${sheet.title}」所选素材` : `撤回批次「${sheet.title}」`, () => {
        for (const changes of blocks.values()) this.revert(id, changes)
      }, { source })
      complete = !ids || !this.db.prepare(`SELECT 1 FROM main.review_delta d WHERE batch=?
        AND NOT EXISTS (SELECT 1 FROM main.review_withdrawn w WHERE w.batch=d.batch AND w.entity_id=d.entity_id) LIMIT 1`).get(id)
    }
    if (complete) this.db.prepare('UPDATE main.review_sheet SET state=?,decided_by=?,decided_at=? WHERE id=?')
      .run(action === 'confirm' ? 'confirmed' : 'withdrawn', source, at, id)
    this.db.prepare("DELETE FROM main.review_sheet WHERE id IN (SELECT id FROM main.review_sheet WHERE state IN ('confirmed','withdrawn') ORDER BY decided_at DESC, rowid DESC LIMIT -1 OFFSET 64)").run()
    this.store.afterCommit(this.changed)
  }

  private revert(batch: string, changes: Delta[]) {
    const first = changes[0], id = first.entity_id, kind = first.kind
    const current = this.store.blocksOf(id, [kind])[kind]?.data ?? null
    const data: BlockData = { ...current }
    const skip = (d: Delta) => this.db.prepare('UPDATE main.review_delta SET touched=1 WHERE batch=? AND entity_id=? AND kind=? AND field=? AND member=?').run(batch,id,kind,d.field,d.member)
    const def = this.reg.kind(kind)
    const canRestoreRefs = changes.every(d => {
      if (d.touched || def?.fields[d.field]?.type !== 'ref') return true
      const prior = JSON.parse(d.prior)
      const targets = d.member ? (prior ? [d.member] : []) : [prior].flat()
      return targets.every(target => !target || (this.store.exists(target) && !this.store.isTrashed(target)))
    })
    const available = this.available(first) && canRestoreRefs
    let removeMembership: Delta | undefined, edited = false
    // 先删新增成员，再按旧位置插回被移除成员，恢复原顺序。
    const ordered = [...changes].sort((a, b) => Number(!!a.member && a.prior === 'true') - Number(!!b.member && b.prior === 'true') || a.position - b.position)
    for (const d of ordered) {
      if (d.touched) continue
      if (!available || json(valueOf(current, d.field, d.member)) !== d.final) { skip(d); continue }
      const prior = JSON.parse(d.prior)
      if (!d.field) { if (!prior) removeMembership = d }
      else if (d.member) {
        const members = ((data[d.field] ?? []) as string[]).filter(v => v !== d.member)
        if (prior) members.splice(d.position, 0, d.member)
        if (members.length) data[d.field] = members
        else delete data[d.field]
      } else if (prior === null) delete data[d.field]
      else data[d.field] = prior
      edited = true
    }
    if (!edited) return
    if (removeMembership && Object.keys(data).length) skip(removeMembership)
    if (!Object.keys(data).length && (removeMembership || (first.kind_version === null && !def?.template))) this.store.remove(id, kind)
    else this.store.put(id, kind, data)
  }
}
