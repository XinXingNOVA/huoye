import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { parseInput, querySchema } from '../shared/automation'
import { executeQuerySchema, QUERY_LIMITS, type ExecuteQueryRequest, type QueryDescription, type QueryResponse } from '../shared/business-queries'
import { canonical } from '../shared/external-plugins'
import type { CorePlugin } from '../plugin-api/core/contracts'
import type { QueryContext, QueryPage } from '../plugin-api/queries'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { Reading } from './reading'
import { countQuery, runFacet } from './query'

export function describeQueries(plugins: CorePlugin[]): QueryDescription[] {
  return plugins.flatMap(p => (p.queries ?? []).map(q => ({
    name: `${p.id}.${q.name}`, plugin: p.id, title: q.title, description: q.description,
    inputSchema: z.toJSONSchema(q.input, { io: 'input' }), outputSchema: z.toJSONSchema(q.output, { io: 'output' }), paginated: !!q.paginated
  })))
}

export function validateQueries(plugin: CorePlugin): void {
  if (plugin.queries !== undefined && !Array.isArray(plugin.queries)) throw new Error('queries 必须为数组')
  const seen = new Set<string>()
  for (const q of plugin.queries ?? []) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(plugin.id) || !/^[a-z][a-z0-9_]{0,63}$/.test(q.name) || seen.has(q.name)) throw new Error(`业务查询 ${plugin.id}.${q.name} 名称无效或重复`)
    seen.add(q.name)
    if (!q.title?.trim() || !q.description?.trim() || typeof q.run !== 'function' || (q.paginated !== undefined && typeof q.paginated !== 'boolean')) throw new Error(`业务查询 ${q.name} 缺少有效说明或同步处理函数`)
    const input = z.toJSONSchema(q.input, { io: 'input' }), output = z.toJSONSchema(q.output, { io: 'output' })
    if (input.type !== 'object' || output.type !== 'object') throw new Error(`业务查询 ${q.name} 的输入输出必须是对象 schema`)
    if (q.paginated && !['items', 'total', 'nextCursor'].every(k => output.required?.includes(k))) throw new Error(`分页查询 ${q.name} 的输出必须包含 items、total、nextCursor`)
  }
}

/** 只接受普通 JSON，避免序列化悄悄丢字段或让输出钩子产生副作用。 */
function jsonCopy<T>(value: T, maxBytes: number, omitUndefined = false): T {
  const seen = new Set<object>()
  const visit = (v: unknown, depth: number): void => {
    if (depth > 40) throw new Error('[QUERY_RESULT] JSON 嵌套过深')
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return
    if (typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && !Array.isArray(v) && Object.getPrototypeOf(v) !== null)) throw new Error('[QUERY_RESULT] 查询只接受普通 JSON 值')
    if (seen.has(v)) throw new Error('[QUERY_RESULT] 查询结果不能循环引用')
    seen.add(v)
    for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if (d.get || d.set) throw new Error('[QUERY_RESULT] JSON 不能包含访问器')
      if (d.enumerable && !(omitUndefined && d.value === undefined && !Array.isArray(v))) visit(d.value, depth + 1)
    }
    seen.delete(v)
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('[QUERY_LIMIT] 查询数据超过大小上限，请缩小字段或分页读取')
  return JSON.parse(json) as T
}

/** 不写历史/回执；同步只读事务中执行。公共上下文不是可信 Node 插件的安全沙箱。 */
export class BusinessQueries {
  private secret = randomBytes(32)
  constructor(private lib: Library, private reg: Registry, private store: Store, private reading: Reading) {}

  execute(raw: ExecuteQueryRequest): QueryResponse {
    const request = parseInput(executeQuerySchema, raw)
    const entry = this.reg.plugins.flatMap(p => (p.queries ?? []).map(q => ({ name: `${p.id}.${q.name}`, q }))).find(e => e.name === request.query)
    if (!entry) throw new Error('[UNAVAILABLE_QUERY] 查询未开放或所属插件已停用')
    if (!entry.q.paginated && (request.cursor !== undefined || request.limit !== undefined)) throw new Error('[INVALID_INPUT] 这个查询不接受分页参数')
    const wasReadOnly = this.lib.db.pragma('query_only', { simple: true }) as number
    this.lib.db.pragma('query_only = ON')
    try {
      return this.lib.db.transaction(() => {
        let alive = true, calls = 0, page: QueryPage<unknown> | undefined
        const guard = () => {
          if (!alive) throw new Error('[QUERY_CONTEXT_EXPIRED] 查询上下文已失效')
          if (++calls > QUERY_LIMITS.calls) throw new Error('[QUERY_LIMIT] 查询读取次数超过上限')
        }
        try {
          const args = parseInput(entry.q.input, jsonCopy(request.args, QUERY_LIMITS.resultBytes))
          const limit = request.limit ?? 20
          const signature = createHash('sha256').update(canonical([entry.name, args, limit])).digest('hex')
          const revision = String(this.lib.db.prepare('SELECT total_changes()').pluck().get())
          let offset = 0
          if (request.cursor) {
            const [payload, mac, extra] = request.cursor.split('.')
            const expected = createHmac('sha256', this.secret).update(payload).digest('hex')
            if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !mac || !/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('[STALE_CURSOR] 游标已失效或不属于本次查询，请从首页重读')
            const saved = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
            if (saved.signature !== signature || saved.revision !== revision || !Number.isSafeInteger(saved.offset) || saved.offset < 0 || saved.offset > QUERY_LIMITS.items) throw new Error('[STALE_CURSOR] 查询参数或仓库数据已变化，请从首页重读')
            offset = saved.offset
          }
          const copy = <T>(value: T): T => jsonCopy(value, QUERY_LIMITS.readBytes, true)
          const ctx: QueryContext = Object.freeze({
            search: (input: Parameters<QueryContext['search']>[0]) => { guard(); return copy(this.reading.search(input)) },
            readItem: (input: Parameters<QueryContext['readItem']>[0]) => { guard(); return copy(this.reading.itemDetails(input)) },
            readContent: (input: Parameters<QueryContext['readContent']>[0]) => { guard(); return copy(this.reading.content(input)) },
            blocksOf: (id: string, kinds?: string[]) => {
              guard()
              parseInput(z.object({ id: z.string().min(1).max(200), kinds: z.array(z.string().min(1).max(200)).max(30).optional() }), { id, ...(kinds ? { kinds } : {}) })
              const item = this.store.get([id])[0]
              if (!item) throw new Error('[NOT_FOUND] 记录不存在')
              return copy(Object.fromEntries(Object.entries(item.blocks).filter(([kind]) => !kinds || kinds.includes(kind))))
            },
            count: (query: Parameters<QueryContext['count']>[0]) => { guard(); return countQuery(this.lib.db, this.reg, parseInput(querySchema, query)) },
            facet: (kind: string, field: string, options?: Parameters<QueryContext['facet']>[2]) => {
              guard()
              parseInput(z.array(z.string().min(1).max(200)).length(2), [kind, field])
              const parsed = parseInput(z.object({
                query: querySchema.extend({ ids: z.array(z.string().min(1).max(200)).max(100).optional() }).optional(),
                limit: z.number().int().min(1).max(QUERY_LIMITS.items).optional()
              }).strict(), options ?? {})
              const values = runFacet(this.lib.db, this.reg, kind, field, { ...parsed, limit: parsed.limit ?? QUERY_LIMITS.items + 1 })
              if (values.length > QUERY_LIMITS.items) throw new Error('[QUERY_LIMIT] 分面超过 10000 项，请使用更具体的查询')
              return copy(values)
            },
            page: <T>(items: readonly T[]): QueryPage<T> => {
              guard()
              if (!entry.q.paginated || page) throw new Error('[QUERY_RESULT] 只有分页查询可调用 page，且每次只能调用一次')
              if (!Array.isArray(items) || items.length > QUERY_LIMITS.items) throw new Error('[QUERY_LIMIT] 业务列表最多 10000 项')
              if (offset > items.length) throw new Error('[STALE_CURSOR] 列表已变化，请从首页重读')
              const values = copy(items), end = Math.min(offset + limit, values.length)
              const payload = Buffer.from(JSON.stringify({ signature, revision, offset: end })).toString('base64url')
              const nextCursor = end < values.length ? `${payload}.${createHmac('sha256', this.secret).update(payload).digest('hex')}` : null
              const result = { items: values.slice(offset, end), total: values.length, nextCursor }
              page = jsonCopy(result, QUERY_LIMITS.readBytes); return result
            }
          })
          const value = entry.q.run(ctx, args)
          if (value && typeof value.then === 'function') {
            void Promise.resolve(value).catch(() => {})
            throw new Error('[QUERY_ASYNC] 业务查询必须同步读取，不支持 Promise')
          }
          const parsed = entry.q.output.safeParse(jsonCopy(value, QUERY_LIMITS.resultBytes))
          if (!parsed.success) throw new Error(`[QUERY_OUTPUT_INVALID] ${parsed.error.issues.map(e => e.path.join('.') + ': ' + e.message).join('; ')}`)
          const result = parsed.data
          if (entry.q.paginated && (!page || !Array.isArray(result.items) || canonical(result.items) !== canonical(page.items) || result.total !== page.total || result.nextCursor !== page.nextCursor)) throw new Error('[QUERY_RESULT] 分页查询必须返回 ctx.page 生成的完整分页结果')
          return jsonCopy({ query: entry.name, result }, QUERY_LIMITS.resultBytes)
        } finally { alive = false }
      })()
    } finally { this.lib.db.pragma(`query_only = ${wasReadOnly ? 'ON' : 'OFF'}`) }
  }
}
