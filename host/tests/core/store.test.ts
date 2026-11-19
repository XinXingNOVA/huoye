import { afterEach, describe, expect, it } from 'vitest'
import type { Query } from '../../src/shared/query'
import { querySchema } from '../../src/shared/query-input'
import { Registry } from '../../src/core/registry'
import type { CorePlugin } from '../../src/core/plugin'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { openHost } from '../helpers/helpers'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function setup() {
  const h = openHost()
  cleanup = h.cleanup
  return h
}

describe('数据块读写', () => {
  it('写入后能读回，只保留声明的字段', () => {
    const { host } = setup()
    const id = host.store.createEntity()
    host.store.put(id, 'note', { text: '冷暖对比', extra: 1 })
    const [view] = host.store.get([id])
    expect(view.blocks.note.data).toEqual({ text: '冷暖对比' })
    expect(view.blocks.note.ver).toBe(1)
  })

  it('字段类型不对时拒绝写入', () => {
    const { host } = setup()
    const id = host.store.createEntity()
    expect(() => host.store.put(id, 'tags', { values: '光影' })).toThrow(/应为列表/)
    expect(() => host.store.put(id, 'note', { text: 42 })).toThrow(/不是有效的 longtext/)
    expect(() => host.store.put(id, 'nope', {})).toThrow(/未知的数据块/)
  })

  it('数据不变时不写入；用户操作变化时写入序号递增并留下历史', () => {
    const { host } = setup()
    const id = host.store.createEntity()
    host.api.put(id, 'note', { text: 'a' })
    const s1 = host.store.blocksOf(id).note.seq
    host.api.put(id, 'note', { text: 'a' })
    expect(host.store.blocksOf(id).note.seq).toBe(s1)
    host.api.put(id, 'note', { text: 'b' })
    expect(host.store.blocksOf(id).note.seq).toBeGreaterThan(s1)

    const history = host.lib.db
      .prepare('SELECT data FROM main.block_history WHERE entity_id = ? ORDER BY seq')
      .pluck()
      .all(id)
    expect(history).toEqual([null, JSON.stringify({ text: 'a' })])
  })

  it('不可重建的写进 library.db，可重建的写进 derived.db', () => {
    const { host } = setup()
    const id = host.store.createEntity()
    host.store.put(id, 'note', { text: 'x' })
    host.store.put(id, 'image', { width: 10, height: 20, animated: false })
    const count = (s: string, kind: string) =>
      host.lib.db.prepare(`SELECT COUNT(*) FROM ${s}.block WHERE kind = ?`).pluck().get(kind)
    expect(count('main', 'note')).toBe(1)
    expect(count('derived', 'note')).toBe(0)
    expect(count('derived', 'image')).toBe(1)
    expect(count('main', 'image')).toBe(0)
  })

  it('移除数据块会同时清掉字段索引', () => {
    const { host } = setup()
    const id = host.store.createEntity()
    host.store.put(id, 'tags', { values: ['光影', '夜景'] })
    host.store.remove(id, 'tags')
    expect(host.store.blocksOf(id).tags).toBeUndefined()
    expect(host.lib.db.prepare('SELECT COUNT(*) FROM main.field_index WHERE entity_id = ?').pluck().get(id)).toBe(0)
  })

  it('界面不能手动写可重建的数据块', () => {
    const { host } = setup()
    const id = host.store.createEntity()
    expect(() => host.api.put(id, 'image', { width: 1, height: 1 })).toThrow(/可重建/)
  })
})

describe('查询', () => {
  function seed(host: ReturnType<typeof setup>['host']) {
    const s = host.store
    const a = s.createEntity(1000)
    s.put(a, 'text', { content: 'a' })
    s.put(a, 'tags', { values: ['光影', '夜景'] })
    const b = s.createEntity(2000)
    s.put(b, 'text', { content: 'b' })
    s.put(b, 'tags', { values: ['光影'] })
    const c = s.createEntity(3000)
    s.put(c, 'text', { content: 'c' })
    // 没有内容类数据块的身份（例如以后的局部、项目）不算素材
    const orphan = s.createEntity(4000)
    s.put(orphan, 'note', { text: '只有笔记' })
    return { a, b, c, orphan }
  }

  it('默认只返回素材，按收录时间倒序', () => {
    const { host } = setup()
    const { a, b, c } = seed(host)
    expect(host.api.query({}) as unknown).toMatchObject({ ids: [c, b, a] })
  })

  it('按标签筛选、按有无数据块筛选', () => {
    const { host } = setup()
    const { a, b, c } = seed(host)
    const q = (query: object) => (host.api.query(query) as { ids: string[] }).ids
    expect(q({ where: [{ op: 'eq', kind: 'tags', field: 'values', value: '光影' }] })).toEqual([b, a])
    expect(q({ where: [{ op: 'eq', kind: 'tags', field: 'values', value: '夜景' }] })).toEqual([a])
    expect(q({ lacks: ['tags'] })).toEqual([c])
    expect(q({ has: ['tags'], dir: 'asc' })).toEqual([a, b])
  })

  it('任一值与其他条件取交集，MCP 同语义、分页不重复；空候选不扩大范围', async () => {
    const { host } = setup(), { a, b, c } = seed(host)
    const query = { where: [{ op: 'in' as const, kind: 'tags', field: 'values', values: ['夜景', '光影', '光影'] }], dir: 'asc' as const }
    expect((await host.api.query(query)).ids).toEqual([a, b])
    const page = await host.api.searchPage({ query, limit: 1 })
    expect(page.items.map(i => i.id)).toEqual([a])
    expect((await host.api.searchPage({ query, limit: 1, cursor: page.nextCursor! })).items.map(i => i.id)).toEqual([b])
    expect((await host.api.query({ ...query, lacks: ['tags'] })).ids).toEqual([])
    expect((await host.api.query({ where: [{ op: 'in', kind: 'tags', field: 'values', values: [] }] })).ids).toEqual([])
    expect((await host.api.query({ where: [{ op: 'empty', kind: 'tags', field: 'values' }] })).ids).toEqual([c])
    expect(querySchema.safeParse({ where: [{ op: 'in', kind: 'tags', field: 'values', values: [] }] }).success).toBe(false)
    expect(querySchema.safeParse({ where: [{ op: 'range', kind: 'file', field: 'size', min: 2, max: 1 }] }).success).toBe(false)
    // 数值、布尔值使用 num 列，文本沿 txt 索引，不依靠字符串比较。
    host.store.put(a, 'file', { name: 'a', ext: 'x', size: 20, hash: 'a', path: 'p' })
    host.store.put(b, 'file', { name: 'b', ext: 'x', size: 3, hash: 'b', path: 'p' })
    expect((await host.api.query({ where: [{ op: 'in', kind: 'file', field: 'size', values: [3, 20] }], sort: { kind: 'file', field: 'size' }, dir: 'asc' })).ids).toEqual([b, a])
  })

  it('回收站：移出素材视图，恢复后回来', () => {
    const { host } = setup()
    const { a, b, c } = seed(host)
    host.store.trash([b])
    const q = (query: object) => (host.api.query(query) as { ids: string[] }).ids
    expect(q({})).toEqual([c, a])
    expect(q({ scope: 'trash' })).toEqual([b])
    host.store.restore([b])
    expect(q({})).toEqual([c, b, a])
  })

  it('分面统计标签，不计回收站中的', () => {
    const { host } = setup()
    const { a } = seed(host)
    expect(host.api.facet('tags', 'values')).toEqual([
      { value: '光影', count: 2 },
      { value: '夜景', count: 1 }
    ])
    host.store.trash([a])
    expect(host.api.facet('tags', 'values')).toEqual([{ value: '光影', count: 1 }])
  })

  it('分面复用完整查询范围，区分省略查询和空查询；limit 限制值而非身份', async () => {
    const { host } = setup(), { a, b, c, orphan } = seed(host)
    host.store.put(orphan, 'tags', { values: ['无内容'] })
    host.store.put(a, 'file', { name: 'photo.png', ext: 'png', size: 20, hash: 'a', path: 'p' })
    host.store.put(b, 'file', { name: 'photo.jpg', ext: 'jpg', size: 3, hash: 'b', path: 'p' })
    host.store.put(a, 'image', { width: 10, height: 20, animated: false })
    host.store.put(c, 'text', { content: '晴朗森林' })
    host.store.put(c, 'tags', { values: ['森林'] })
    const managed = host.store.createEntity()
    host.store.put(managed, 'tagGroups', { groups: [] })
    expect((await host.api.facet('tags', 'values')).map(x => x.value)).toEqual(['光影', '夜景', '无内容', '森林'])
    expect((await host.api.facet('tags', 'values', { query: {} })).map(x => x.value)).toEqual(['光影', '夜景', '森林'])
    expect(host.api.facet('tags', 'values', { limit: 1 })).toEqual([{ value: '光影', count: 2 }])
    for (const limit of [0, -1, 1.5, NaN]) expect(() => host.api.facet('tags', 'values', { limit })).toThrow('正整数')
    expect(host.api.kindCounts(['tags', 'tags', 'unknown'])).toEqual({ tags: 4, unknown: 0 })
    expect(host.api.kindCounts([])).toEqual({})
    expect(() => host.api.kindCounts(Array(1001).fill('tags'))).toThrow('1000')
    host.store.trash([b])
    const queries: Query[] = [
      { ids: [] }, { ids: [a, a, c], has: ['image'] }, { lacks: ['file'] },
      { where: [{ op: 'range', kind: 'file', field: 'size', min: 10 }] },
      { where: [{ op: 'in', kind: 'file', field: 'ext', values: ['png', 'jpg'] }] },
      { where: [{ op: 'empty', kind: 'file', field: 'ext' }] },
      { search: [{ kind: 'text', field: 'content', text: '森林' }] },
      { scope: 'trash' }, { scope: 'all', role: 'management' }, { scope: 'all', role: 'material' }
    ]
    for (const query of queries) {
      const counts = new Map<string, number>()
      for (const view of host.store.get((await host.api.query(query)).ids)) {
        for (const tag of new Set(view.blocks.tags?.data.values as string[] ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
      expect(new Map((await host.api.facet('tags', 'values', { query })).map(x => [x.value, x.count]))).toEqual(counts)
      const kinds = ['tags', 'image', 'file', 'text', 'tagGroups', 'unknown']
      const views = host.store.get((await host.api.query(query)).ids)
      expect(host.api.kindCounts(kinds, query)).toEqual(Object.fromEntries(kinds.map(kind => [kind, views.filter(v => v.blocks[kind]).length])))
    }
  })

  it('按字段排序，没有该字段的排在最后', () => {
    const { host } = setup()
    const s = host.store
    const ids = [300, 100, 200].map((size) => {
      const id = s.createEntity()
      s.put(id, 'file', { name: `${size}.bin`, ext: 'bin', mime: 'x', size, hash: String(size), path: 'p' })
      return id
    })
    const none = s.createEntity()
    s.put(none, 'text', { content: 'no size' })
    const res = host.api.query({ sort: { kind: 'file', field: 'size' }, dir: 'asc' }) as { ids: string[] }
    expect(res.ids).toEqual([ids[1], ids[2], ids[0], none])
  })

  it('没有索引的字段不能用于筛选', () => {
    const { host } = setup()
    expect(() => host.api.query({ where: [{ op: 'eq', kind: 'file', field: 'path', value: 'x' }] })).toThrow(/没有声明索引/)
  })
})

describe('插件装配检查', () => {
  it('System 不能产出不可重建的数据块', () => {
    const bad: CorePlugin = {
      id: 'bad',
      version: 1,
      systems: [{ id: 'bad.note', priority: 0, has: ['file'], outputs: ['note'], run: async () => ({}) }]
    }
    expect(() => new Registry([...corePlugins, bad])).toThrow(/不能产出不可重建/)
  })
})
