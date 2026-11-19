import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'
import { queryPageSchema, type QueryContext, type QueryDefinition } from '../../src/plugin-api/queries'
import { Registry } from '../../src/core/registry'
import { openHost } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
const empty = z.object({}).strict()
const sample: CorePlugin = {
  id: 'sample', version: 1,
  blocks: [
    { id: 'sample', plugin: 'sample', title: '测试', version: 1, rebuildable: false, content: true,
      fields: { text: { type: 'longtext', title: '正文', search: true }, category: { type: 'text', title: '分类', index: true } } },
    { id: 'sample-config', plugin: 'sample', title: '管理', version: 1, rebuildable: false, standalone: true, management: {}, fields: {} }
  ]
}
const definition = (run: QueryDefinition['run'], changes: Partial<QueryDefinition> = {}): QueryDefinition => ({
  name: 'inspect', title: '读取', description: '只读测试', input: empty, output: z.record(z.string(), z.unknown()), run, ...changes
})
const fixture = (queries: QueryDefinition[]) => {
  const h = openHost([{ ...sample, queries }], { manifest: [{ id: 'sample', title: '测试', description: '' }] })
  cleanups.push(() => h.cleanup())
  return h
}
const rows = definition(ctx => ({ ...ctx.page(['a', 'b', 'c']) }), { name: 'rows', paginated: true, output: queryPageSchema(z.string()), input: z.object({ filter: z.string().default('') }).strict() })

describe('插件业务只读查询', () => {
  it('发现输入输出契约，隔离副本，复用通用读且不生成历史和回执', async () => {
    let id = '', retained: QueryContext | undefined
    const h = fixture([definition(ctx => {
      retained = ctx
      expect(Object.isFrozen(ctx)).toBe(true)
      for (const method of ['put', 'patch', 'remove', 'run', 'writeFile', 'db']) expect(method in ctx).toBe(false)
      const blocks = ctx.blocksOf(id, ['sample'])
      blocks.sample.data.text = '改副本'
      return { total: ctx.count({}), search: ctx.search({ query: {} }).items.length,
        item: ctx.readItem({ id }).id, text: ctx.readContent({ id, kind: 'sample', field: 'text' }).text,
        facet: ctx.facet('sample', 'category') }
    })])
    id = await h.host.api.create({ sample: { text: '原文', category: '设计' } })
    const before = h.host.lib.db.prepare('SELECT total_changes()').pluck().get()
    const result = await h.host.api.executeQuery({ query: 'sample.inspect' })
    expect(result.result).toMatchObject({ total: 1, search: 1, item: id, text: '原文', facet: [{ value: '设计', count: 1 }] })
    expect(h.host.lib.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
    expect(() => retained!.count({})).toThrow('QUERY_CONTEXT_EXPIRED')
    expect((await h.host.api.readContent({ id, kind: 'sample', field: 'text' })).text).toBe('原文')
    expect((await h.host.api.describeLibrary()).queries[0]).toMatchObject({ name: 'sample.inspect', plugin: 'sample', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, paginated: false })
  })
  it('业务分面接受有界查询与值数量限制，省略选项保持全库；空身份范围为空', async () => {
    let options: Parameters<QueryContext['facet']>[2]
    const h = fixture([definition(ctx => ({ items: ctx.facet('sample', 'category', options) }))])
    const a = await h.host.api.create({ sample: { text: '甲', category: '设计' } })
    await h.host.api.create({ sample: { text: '乙', category: '阅读' } })
    const read = () => h.host.api.executeQuery({ query: 'sample.inspect' })
    expect((await read()).result.items).toHaveLength(2)
    options = { query: { ids: [a] }, limit: 1 }
    expect((await read()).result.items).toEqual([{ value: '设计', count: 1 }])
    options = { query: { ids: [] } }
    expect((await read()).result.items).toEqual([])
    options = { limit: 10001 }
    expect(read).toThrow('INVALID_INPUT')
    options = { query: { ids: Array(101).fill(a) } }
    expect(read).toThrow('INVALID_INPUT')
  })
  it('数据库防误写保护及异常恢复；不把写权限借给查询', async () => {
    const h = fixture([definition(() => { h.host.lib.db.prepare("INSERT INTO main.config (key,value) VALUES ('bad','true')").run(); return {} })])
    expect(() => h.host.api.executeQuery({ query: 'sample.inspect' })).toThrow(/readonly/)
    expect(h.host.lib.db.pragma('query_only', { simple: true })).toBe(0)
    expect(h.host.lib.db.prepare("SELECT * FROM main.config WHERE key='bad'").get()).toBeUndefined()
    await h.host.api.create({ sample: { text: '仍可写' } })
  })
  it('分页游标绑定查询、参数、页大小、仓库实例与数据版本', async () => {
    const h = fixture([rows, { ...rows, name: 'other' }])
    const first = await h.host.api.executeQuery({ query: 'sample.rows', limit: 2 })
    expect(first.result).toMatchObject({ items: ['a', 'b'], total: 3 })
    const cursor = first.result.nextCursor as string
    expect((await h.host.api.executeQuery({ query: 'sample.rows', limit: 2, cursor })).result).toEqual({ items: ['c'], total: 3, nextCursor: null })
    for (const req of [{ query: 'sample.other', limit: 2 }, { query: 'sample.rows', limit: 1 }, { query: 'sample.rows', limit: 2, args: { filter: 'x' } }]) {
      expect(() => h.host.api.executeQuery({ ...req, cursor })).toThrow('STALE_CURSOR')
    }
    expect(() => h.host.api.executeQuery({ query: 'sample.rows', cursor: 'bad' })).toThrow('STALE_CURSOR')
    expect(() => h.host.api.executeQuery({ query: 'sample.rows', cursor: `payload.${'中'.repeat(64)}` })).toThrow('STALE_CURSOR')
    const other = fixture([rows])
    expect(() => other.host.api.executeQuery({ query: 'sample.rows', limit: 2, cursor })).toThrow('STALE_CURSOR')
    await h.host.api.create({ sample: { text: '数据变化' } })
    expect(() => h.host.api.executeQuery({ query: 'sample.rows', limit: 2, cursor })).toThrow('STALE_CURSOR')
    expect(() => h.host.api.executeQuery({ query: 'sample.rows', limit: 51 })).toThrow('INVALID_INPUT')
  })
  it('输入输出、读取次数、输出大小和异步误用都显式拒绝', () => {
    const h = fixture([
      definition(() => ({ value: 'wrong' }), { name: 'bad_output', output: z.object({ value: z.number() }) }),
      definition(() => ({ text: 'x'.repeat(65536) }), { name: 'huge' }),
      definition(ctx => { for (let i = 0; i < 101; i++) ctx.count({}); return {} }, { name: 'loop' }),
      definition(() => Promise.reject(new Error('async')) as unknown as Record<string, unknown>, { name: 'async' }),
      definition(() => ({ items: [], total: 0, nextCursor: null }), { name: 'fake_page', paginated: true, output: queryPageSchema(z.string()) }),
      definition(ctx => { const page = ctx.page(['original']); page.items[0] = 'changed'; return { ...page } }, { name: 'changed_page', paginated: true, output: queryPageSchema(z.string()) }),
      definition(ctx => ({ ...ctx.page(Array(10001).fill('x')) }), { name: 'huge_page', paginated: true, output: queryPageSchema(z.string()) }),
      definition(() => ({ get text() { throw new Error('getter ran') } }), { name: 'getter' })
    ])
    for (const [name, error] of [['bad_output','QUERY_OUTPUT_INVALID'], ['huge','QUERY_LIMIT'], ['loop','QUERY_LIMIT'], ['async','QUERY_ASYNC'], ['fake_page','QUERY_RESULT'], ['changed_page','QUERY_RESULT'], ['huge_page','QUERY_LIMIT'], ['getter','访问器']]) {
      expect(() => h.host.api.executeQuery({ query: `sample.${name}` })).toThrow(error)
    }
    expect(() => h.host.api.executeQuery({ query: 'sample.huge', args: { extra: true } })).toThrow('INVALID_INPUT')
    expect(() => h.host.api.executeQuery({ query: 'sample.huge', limit: 1 })).toThrow('INVALID_INPUT')
    expect(() => h.host.api.executeQuery({ query: 'missing.huge' })).toThrow('UNAVAILABLE_QUERY')
  })
  it('count 与现有过滤一致：管理记录、回收站、文本与字段', async () => {
    const h = fixture([definition(ctx => ({
      active: ctx.count({}), all: ctx.count({ scope: 'all' }), managed: ctx.count({ scope: 'all', role: 'management' }),
      trash: ctx.count({ scope: 'trash' }), text: ctx.count({ text: '苹果' }),
      field: ctx.count({ where: [{ kind: 'sample', field: 'category', op: 'eq', value: 'A' }] }),
      missing: ctx.count({ has: ['absent'] }), lacking: ctx.count({ lacks: ['absent'] })
    }))])
    await h.host.api.create({ sample: { text: '苹果', category: 'A' } })
    const removed = await h.host.api.create({ sample: { text: '删除', category: 'B' } })
    await h.host.api.create({ 'sample-config': {} })
    await h.host.api.trash([removed])
    expect((await h.host.api.executeQuery({ query: 'sample.inspect' })).result).toEqual({ active: 1, all: 2, managed: 1, trash: 1, text: 1, field: 1, missing: 0, lacking: 1 })
  })
  it('停用后查询消失，原始数据通用读取仍可用', async () => {
    const h = fixture([rows])
    const id = await h.host.api.create({ sample: { text: '保留' } })
    await h.host.api.setPlugins(['sample']); h.host.close()
    const reopened = openHost([{ ...sample, queries: [rows] }], { manifest: [{ id: 'sample', title: '测试', description: '' }] }, h.root)
    cleanups.push(() => reopened.host.close())
    expect((await reopened.host.api.describeLibrary()).queries).toEqual([])
    expect(() => reopened.host.api.executeQuery({ query: 'sample.rows' })).toThrow('UNAVAILABLE_QUERY')
    expect((await reopened.host.api.readContent({ id, kind: 'sample', field: 'text' })).text).toBe('保留')
  })
  it('注册时拒绝重名、无说明、非对象契约和不完整分页声明', () => {
    for (const queries of [[rows, rows], [{ ...rows, description: '' }], [{ ...rows, name: 'Bad.Name' }], [{ ...rows, output: z.string() }], [{ ...rows, output: empty }]]) {
      expect(() => new Registry([{ ...sample, queries: queries as QueryDefinition[] }])).toThrow()
    }
  })
})
