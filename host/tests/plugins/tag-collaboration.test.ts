import { afterEach, expect, it } from 'vitest'
import { tagsPlugin } from '@test-plugins/tags/core'
import { groupsPlugin } from '@test-plugins/tag-groups/core'
import { plugin as treePlugin } from '@test-plugins/tag-tree/core'
import { branchCondition } from '@test-plugins/tag-tree/model'
import { openHost } from '../helpers/helpers'
import type { Query } from '../../src/shared/query'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
function fixture() {
  const h = openHost([tagsPlugin, groupsPlugin, treePlugin], { manifest: [tagsPlugin, groupsPlugin, treePlugin].map(p => ({ id: p.id, title: p.id, description: '', ...(p.id !== 'tags' ? { requires: ['tags'] } : {}) })) })
  cleanups.push(h.cleanup); return h
}
it('两种关系独立；旧分组显式接续，删除到空后不复活；同批撤销恢复', async () => {
  const { host } = fixture()
  const material = await host.api.create({ tags: { values: ['Logic'] } })
  const old = await host.api.create({ tagGroups: { groups: [{ id: 'legacy', title: '常用', tags: ['Logic'] }] } })
  expect((await host.api.executeQuery({ query: 'tag-groups.list_groups' })).result.items).toEqual([])
  host.api.run('tag-groups', 'importLegacy', {})
  host.api.undo()
  expect((await host.api.executeQuery({ query: 'tag-groups.list_groups' })).result.items).toEqual([])
  host.api.run('tag-groups', 'importLegacy', {})
  host.api.run('tag-tree', 'setParent', { tag: 'Logic', parent: 'Math' })
  host.api.run('tag-groups', 'renameGroup', { group: 'legacy', title: '收藏' })
  expect(host.store.blocksOf(old).tagGroups.data.groups).toEqual([{ id: 'legacy', title: '常用', tags: ['Logic'] }])
  expect(host.store.blocksOf(material).tags.data.values).toEqual(['Logic'])
  host.api.run('tag-groups', 'deleteGroup', { group: 'legacy' })
  expect((await host.api.executeQuery({ query: 'tag-groups.list_groups' })).result.items).toEqual([])
  host.api.undo()
  expect((await host.api.executeQuery({ query: 'tag-groups.list_groups' })).result.items).toMatchObject([{ id: 'legacy', title: '收藏' }])
  expect((await host.api.executeQuery({ query: 'tag-tree.list_nodes' })).result.nodes).toHaveLength(2)
})
it('保存的分支随关系更新，计数按素材去重；循环失败不改库；MCP 回执重放和撤销', async () => {
  const { host } = fixture()
  const a = await host.api.create({ tags: { values: ['Logic', 'Metrics'] } })
  const b = await host.api.create({ tags: { values: ['Math'] } })
  const c = await host.api.create({ tags: { values: ['New'] } })
  const query: Query = { scope: 'all', role: 'material', where: [branchCondition('Math')] }
  const request = { operation: 'tag_tree_set_parent', requestId: 'parent-request-1', args: { tag: 'Logic', parent: 'Math' } }
  await host.api.executeOperation(request); await host.api.executeOperation(request)
  host.api.run('tag-tree', 'setParent', { tag: 'Metrics', parent: 'Logic' })
  expect((await host.api.query(query)).ids.sort()).toEqual([a, b].sort())
  expect((await host.api.executeQuery({ query: 'tag-tree.branch', args: { tag: 'Math' } })).result.count).toBe(2)
  expect(() => host.api.run('tag-tree', 'setParent', { tag: 'Math', parent: 'Metrics' })).toThrow('后代')
  host.api.run('tag-tree', 'setParent', { tag: 'New', parent: 'Math' })
  expect((await host.api.query(query)).ids).toHaveLength(3)
  expect(await host.api.facet('tags', 'values', { query })).toContainEqual({ value: 'New', count: 1 })
  host.api.undo()
  expect((await host.api.query(query)).ids).not.toContain(c)
  host.api.run('tag-tree', 'remove', { tag: 'Logic' })
  expect((await host.api.query(query)).ids.sort()).toEqual([a, b].sort()) // Metrics 提升到 Math
  expect(host.store.blocksOf(a).tags.data.values).toEqual(['Logic', 'Metrics'])
})
