import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '../../src/core/host'
import type { QueryResult } from '../../src/shared/query'
import type { TagGroup } from '../fixtures/legacy-tags/blocks'
import { openHost } from '../helpers/helpers'

let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined })
const setup = () => (current = openHost()).host
const reopen = () => {
  const root = current!.root
  current!.host.close()
  return (current = openHost(undefined, undefined, root)).host
}
const run = (host: Host, command: string, args: Record<string, unknown>) => host.api.run('tags', command, args)
const ids = (result: unknown) => (result as QueryResult).ids
const groups = (host: Host) => {
  const found = ids(host.api.query({ scope: 'all', has: ['tagGroups'] }))
  return found.length ? host.store.blocksOf(found[0]).tagGroups.data.groups as TagGroup[] : []
}

describe('标签分组：组织侧栏，保留素材上的具体标签', () => {
  it('旧库直接使用；分组和移动不改变素材、分面数量、筛选或全文搜索', () => {
    const host = setup()
    const a = host.api.create({ text: { content: '光影参考' }, tags: { values: ['光影', '配色'] } }) as string
    const b = host.api.create({ text: { content: '第二张' }, tags: { values: ['光影'] } }) as string
    const query = { where: [{ op: 'eq' as const, kind: 'tags', field: 'values', value: '光影' }] }
    const before = host.api.get([a, b])
    const facet = host.api.facet('tags', 'values')
    const found = host.api.query(query)
    const search = host.api.query({ text: '光影' })
    expect(groups(host)).toEqual([])
    const group = run(host, 'createGroup', { title: ' 主题 ', tag: '光影' })
    run(host, 'moveTag', { group, tag: '配色' })
    expect(groups(host)).toEqual([{ id: group, title: '主题', tags: ['光影', '配色'] }])
    expect(host.api.get([a, b])).toEqual(before)
    expect(host.api.facet('tags', 'values')).toEqual(facet)
    expect(host.api.query(query)).toEqual(found)
    expect(host.api.query({ text: '光影' })).toEqual(search)
    expect(ids(host.api.query({})).sort()).toEqual([a, b].sort())
    expect(ids(host.api.query({ text: '主题' }))).toEqual([])
  })

  it('跨组移动一次撤销；改名保持组 ID；删除只解散分组并可以撤销', () => {
    const host = setup()
    const material = host.api.create({ text: { content: '参考' }, tags: { values: ['光影'] } }) as string
    const a = run(host, 'createGroup', { title: '主题', tag: '光影' })
    const b = run(host, 'createGroup', { title: '用途' })
    run(host, 'moveTag', { tag: '光影', group: b })
    expect(groups(host).map((g) => g.tags)).toEqual([[], ['光影']])
    host.api.undo()
    expect(groups(host).map((g) => g.tags)).toEqual([['光影'], []])
    host.api.redo()
    expect(groups(host).map((g) => g.tags)).toEqual([[], ['光影']])
    run(host, 'renameGroup', { group: b, title: '参考用途' })
    expect(groups(host)[1]).toEqual({ id: b, title: '参考用途', tags: ['光影'] })
    run(host, 'deleteGroup', { group: b })
    expect(groups(host)).toEqual([{ id: a, title: '主题', tags: [] }])
    expect(host.store.blocksOf(material).tags.data.values).toEqual(['光影'])
    host.api.undo()
    expect(groups(host)[1].tags).toEqual(['光影'])
    run(host, 'moveTag', { tag: '光影', group: null })
    expect(groups(host).every((g) => !g.tags.length)).toBe(true)
  })

  it('移入新分组是一次操作；撤销第一次建组后仍能重新整理', () => {
    const host = setup()
    run(host, 'createGroup', { title: '主题', tag: '光影' })
    host.api.undo()
    expect(groups(host)).toEqual([])
    host.api.redo()
    expect(groups(host)[0].tags).toEqual(['光影'])
    run(host, 'createGroup', { title: '颜色', tag: '光影' })
    expect(groups(host).map((g) => g.tags)).toEqual([[], ['光影']])
    host.api.undo()
    expect(groups(host).map((g) => g.tags)).toEqual([['光影']])
    host.api.undo()
    run(host, 'createGroup', { title: '用途', tag: '光影' })
    expect(groups(host).map((g) => g.title)).toEqual(['用途'])
    expect(ids(host.api.query({ scope: 'all', has: ['tagGroups'] }))).toHaveLength(1)
  })

  it('无效名称、失效目标和重复归属不产生部分修改；预演不写入', () => {
    const host = setup()
    host.api.preview('tags', 'createGroup', { title: '预演' })
    expect(groups(host)).toEqual([])
    const a = run(host, 'createGroup', { title: '主题', tag: '光影' })
    const before = groups(host)
    for (const title of ['', ' ', '主题', '未分组']) expect(() => run(host, 'createGroup', { title })).toThrow()
    expect(() => run(host, 'moveTag', { tag: '光影', group: 'gone' })).toThrow(/不存在/)
    expect(() => run(host, 'renameGroup', { group: a, title: ' ' })).toThrow()
    expect(groups(host)).toEqual(before)
    const record = ids(host.api.query({ scope: 'all', has: ['tagGroups'] }))[0]
    expect(() => host.api.put(record, 'tagGroups', { groups: [...before, { id: 'b', title: '颜色', tags: ['光影'] }] })).toThrow(/多个分组/)
    expect(groups(host)).toEqual(before)
  })

  it('分组随仓库保存；标签暂时无素材仍保留归属，插件停用再启用可恢复', () => {
    let host = setup()
    const material = host.api.create({ text: { content: '参考' }, tags: { values: ['光影'] } }) as string
    const a = run(host, 'createGroup', { title: '主题', tag: '光影' })
    host.api.trash([material])
    expect(host.api.facet('tags', 'values')).toEqual([])
    const saved = [{ id: a, title: '主题', tags: ['光影'] }]
    host = reopen()
    expect(groups(host)).toEqual(saved)
    host.api.setPlugins(['tags'])
    host = reopen()
    expect(groups(host)).toEqual(saved)
    expect(host.reg.kind('tagGroups')?.dormant).toBe(true)
    expect(() => run(host, 'deleteGroup', { group: a })).toThrow(/没有命令/)
    host.api.setPlugins([])
    host = reopen()
    expect(groups(host)).toEqual(saved)
    host.api.restore([material])
    expect(host.api.facet('tags', 'values')).toEqual([{ value: '光影', count: 1 }])
    run(host, 'renameGroup', { group: a, title: '主题参考' })
    expect(groups(host)[0].title).toBe('主题参考')
  })
})
