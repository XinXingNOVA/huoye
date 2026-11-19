import { afterEach, expect, it } from 'vitest'
import { openHost } from '../helpers/helpers'
import { Registry } from '../../src/core/registry'
import { runQuery, runFacet } from '../../src/core/query'
import { querySchema } from '../../src/shared/query-input'
import { splitConditions, type Query } from '../../src/shared/query'
import type { CorePlugin } from '../../src/core/plugin'
const plugin: CorePlugin = { id: 'tree-test', version: 1, blocks: [
  { id: 'items', plugin: 'tree-test', title: '内容', version: 1, rebuildable: false, content: true, fields: { values: { type: 'text', title: '分类', list: true, index: true } } },
  { id: 'links', plugin: 'tree-test', title: '关系', version: 1, rebuildable: false, standalone: true, management: {}, fields: { key: { type: 'text', title: '键', index: true }, parent: { type: 'text', title: '父', index: true } } }
] }
let h: ReturnType<typeof openHost>
afterEach(() => h?.cleanup())
it('通用层级索引查询遵守范围、循环终止、去重、休眠失败与根写入', async () => {
  h = openHost([plugin])
  const a = await h.host.api.create({ items: { values: ['child', 'grandchild'] } })
  const b = await h.host.api.create({ items: { values: ['root'] } })
  h.host.api.create({ links: { key: 'child', parent: 'root' } })
  h.host.api.create({ links: { key: 'grandchild', parent: 'child' } })
  const q: Query = { where: [{ op: 'subtree', kind: 'items', field: 'values', value: 'root', tree: { kind: 'links', key: 'key', parent: 'parent' } }] }
  expect(querySchema.parse(q)).toEqual(q)
  expect((await h.host.api.query(q)).ids.sort()).toEqual([a,b].sort())
  expect((await h.host.api.query({ ...q, ids: [a] })).ids).toEqual([a])
  // 外部写坏的关系也不能让读取无限递归。
  h.host.api.create({ links: { key: 'root', parent: 'grandchild' } })
  expect((await h.host.api.query(q)).ids).toHaveLength(2)
  const reg = new Registry([plugin])
  expect(runFacet(h.host.lib.db, reg, 'items', 'values', { query: q })).toHaveLength(3)
  const dormant = new Registry([{ ...plugin, blocks: [plugin.blocks![0]] }]); dormant.setDormant([plugin.blocks![1]])
  expect(() => runQuery(h.host.lib.db, dormant, q)).toThrow('未启用')
  const split = splitConditions(q, id => ({ title: id, rebuildable: false, fields: { values: { title: '分类', list: true } } }))!
  expect(split.write).toEqual([{ op: 'eq', kind: 'items', field: 'values', value: 'root' }])
  expect(split.check.where).toEqual(q.where)
})
