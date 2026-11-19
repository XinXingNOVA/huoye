import { describeCondition, noChecks, searchesOf, splitConditions, type Cond, type Query, type WriteCond } from '../shared/query'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { History } from './history'
import type { Scheduler } from './scheduler'
import type { BlockEditing } from './block-editing'
import { runQuery } from './query'

/** 将视图条件转成准入检查与数据写入；等待加工后，在同一事务里检查并提交。 */
export class Admission {
  constructor(private lib: Library, private reg: Registry, private store: Store, private history: History,
    private scheduler: Scheduler, private editing: BlockEditing) {}

  private describe(write: WriteCond[], attach: string[] = []): string {
    return [...attach.map(k => `挂上${this.editing.title(k)}`), ...write.map(c => describeCondition(c, k => this.reg.kind(k)))].join('，')
  }

  private write(ids: string[], conds: WriteCond[], attach: string[] = []): void {
    this.store.assertMaterials(ids)
    if (!conds.length && !attach.length) return
    for (const id of ids) {
      if (!this.store.exists(id)) continue
      const blocks = this.store.blocksOf(id)
      for (const kind of attach) {
        if (!blocks[kind] && !conds.some(c => c.kind === kind)) this.editing.put(id, kind, {})
      }
      const next = new Map<string, Record<string, unknown>>()
      for (const c of conds) {
        const data = next.get(c.kind) ?? { ...(blocks[c.kind]?.data ?? {}) }
        const field = this.reg.requireKind(c.kind).fields[c.field]
        if (c.op === 'empty') delete data[c.field]
        else if (field.list) {
          const list = Array.isArray(data[c.field]) ? [...(data[c.field] as unknown[])] : []
          if (!list.includes(c.value)) list.push(c.value)
          data[c.field] = list
        } else data[c.field] = c.value
        next.set(c.kind, data)
      }
      for (const [kind, data] of next) {
        // 挂上空模板是明确意图；单纯清空字段则可移除空块。
        if (Object.values(data).every(v => v === undefined || v === null) && !attach.includes(kind)) {
          if (blocks[kind]) this.editing.remove(id, kind)
        } else this.editing.put(id, kind, data)
      }
    }
  }

  private firstFailure(id: string, check: Query): string {
    const kindOf = (k: string) => this.reg.kind(k)
    const one = (q: Query) => runQuery(this.lib.db, this.reg, { scope: 'all', ...q, ids: [id] }).ids.length > 0
    if (check.scope === 'content' || check.scope === undefined) {
      if (!one({ scope: 'content' })) return '不是素材'
    }
    for (const k of check.has ?? []) if (!one({ has: [k] })) return describeCondition({ has: k }, kindOf)
    for (const k of check.lacks ?? []) if (!one({ lacks: [k] })) return describeCondition({ lacks: k }, kindOf)
    for (const c of check.where ?? []) if (!one({ where: [c] })) return describeCondition(c, kindOf)
    for (const s of searchesOf(check)) if (!one({ search: [s] })) return describeCondition(s, kindOf)
    return '不满足视图条件'
  }

  apply(ids: string[], where: Cond[]): void {
    const split = splitConditions({ where }, k => this.reg.kind(k))
    if (!split || !noChecks(split.check)) throw new Error('这些条件不能直接写入（含可重建或内容类字段，或不是"等于"）')
    this.history.run(`写上：${this.describe(split.write)}`, () => this.write(ids, split.write))
  }

  async admit(ids: string[], query: Query) {
    const split = splitConditions(query, k => this.reg.kind(k))
    if (!split) return { accepted: [], rejected: ids.map(id => ({ id, reason: query.role === 'management' ? '管理视图不接受拖入' : '回收站不接受拖入' })) }
    const { check } = split
    const kinds = [...(check.has ?? []), ...(check.lacks ?? []), ...(check.where ?? []).map(c => c.kind), ...searchesOf(check).flatMap(s => s.kind ? [s.kind] : [])]
    await this.scheduler.settle(ids, kinds)
    return this.admitReady(ids, query)
  }

  /** 已准备的输入在正式收录事务里再验收；这里不能等待异步加工。 */
  admitReady(ids: string[], query: Query) {
    const split = splitConditions(query, k => this.reg.kind(k))
    if (!split) return { accepted: [], rejected: ids.map(id => ({ id, reason: query.role === 'management' ? '管理视图不接受拖入' : '回收站不接受拖入' })) }
    const { write, attach } = split
    const what = this.describe(write, attach)
    return this.history.run(r => `放入：${what || '视图'}（${r.accepted.length} 项）`, () => {
      const unique = [...new Set(ids)]
      const live = unique.filter(id => this.store.exists(id) && !this.store.isTrashed(id))
      const living = new Set(live), allowed = query.ids && new Set(query.ids)
      let accepted: string[] = []
      const rejected = unique.filter(id => !living.has(id)).map(id => ({ id, reason: '素材不存在或已在回收站' }))
      // 在保存点中批量写确定值，再沿索引验收最终结果。失败项不留下字段或历史；
      // 有拒绝时回滚这次试写，只提交通过项，避免逐素材查询整个字段索引。
      const mismatch = Symbol('admission')
      try {
        this.store.batch(() => {
          this.write(live, write, attach)
          const eligible = allowed ? live.filter(id => allowed.has(id)) : live
          const pass = new Set(runQuery(this.lib.db, this.reg, { ...query, sort: undefined, ids: eligible }).ids)
          accepted = live.filter(id => pass.has(id))
          for (const id of live) if (!pass.has(id)) rejected.push({ id, reason: !allowed || allowed.has(id) ? this.firstFailure(id, query) : '不在指定素材范围内' })
          if (accepted.length !== live.length) throw mismatch
        })
      } catch (e) {
        if (e !== mismatch) throw e
        this.write(accepted, write, attach)
      }
      return { accepted, rejected }
    })
  }
}
