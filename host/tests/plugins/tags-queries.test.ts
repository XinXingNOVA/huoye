import { afterEach, describe, expect, it } from 'vitest'
import { groupsPlugin } from '@test-plugins/tag-groups/core'
import { tagsPlugin } from '@test-plugins/tags/core'
import { openHost } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
const fixture = () => {
  const h = openHost([tagsPlugin, groupsPlugin], { manifest: [{ id: 'tags', title: '标签', description: '' }, { id: 'tag-groups', title: '分组', description: '', requires: ['tags'] }] })
  cleanups.push(() => h.cleanup())
  return h
}
type Page = { items: Record<string, unknown>[]; total: number; nextCursor: string | null }
const pageOf = async (h: ReturnType<typeof fixture>, request: Parameters<typeof h.host.api.executeQuery>[0]) =>
  (await h.host.api.executeQuery(request)).result as Page

describe('标签插件的业务查询', () => {
  it('分组、成员、未分组与素材数量都按插件规则解释', async () => {
    const h = fixture()
    h.host.api.create({ tags: { values: ['姿势:坐姿', '姿势:回眸'] } })
    h.host.api.create({ tags: { values: ['姿势:坐姿'] } })
    h.host.api.create({ tags: { values: ['风格:厚涂'] } })
    h.host.api.run('tag-groups', 'createGroup', { title: '姿态', tag: '姿势:坐姿' })
    h.host.api.run('tag-groups', 'createGroup', { title: '神态', tag: '姿势:回眸' })

    const groups = await pageOf(h, { query: 'tag-groups.list_groups' })
    expect(groups.items).toMatchObject([
      { title: '姿态', tagCount: 1 },
      { title: '神态', tagCount: 1 }
    ])
    const posture = groups.items[0] as { id: string }

    expect((await pageOf(h, { query: 'tag-groups.list_tags', limit: 50 })).items).toMatchObject([
      { tag: '姿势:坐姿', materialCount: 2, groupTitle: '姿态' },
      { tag: '姿势:回眸', materialCount: 1, groupTitle: '神态' },
      { tag: '风格:厚涂', materialCount: 1, groupId: null, groupTitle: null }
    ])
    expect((await pageOf(h, { query: 'tag-groups.list_tags', args: { groupId: null } })).items)
      .toMatchObject([{ tag: '风格:厚涂', materialCount: 1 }])
    expect((await pageOf(h, { query: 'tag-groups.list_tags', args: { groupId: posture.id } })).items)
      .toMatchObject([{ tag: '姿势:坐姿', materialCount: 2, groupId: posture.id }])
    expect((await pageOf(h, { query: 'tag-groups.list_tags', args: { prefix: '风格:' } })).items)
      .toMatchObject([{ tag: '风格:厚涂' }])
  })

  it('分组目录里暂时没有素材的标签仍然列出，计数为 0', async () => {
    const h = fixture()
    h.host.api.create({ tags: { values: ['姿势:坐姿'] } })
    h.host.api.run('tag-groups', 'createGroup', { title: '姿态', tag: '姿势:坐姿' })
    h.host.api.run('tag-groups', 'createGroup', { title: '待用', tag: '姿势:待归类' })
    expect((await pageOf(h, { query: 'tag-groups.list_tags' })).items).toMatchObject([
      { tag: '姿势:坐姿', materialCount: 1 },
      { tag: '姿势:待归类', materialCount: 0, groupTitle: '待用' }
    ])
  })

  it('没有分组记录时返回空目录，未知分组显式报错', async () => {
    const h = fixture()
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toEqual([])
    expect((await pageOf(h, { query: 'tag-groups.list_tags' })).total).toBe(0)
    expect(() => h.host.api.executeQuery({ query: 'tag-groups.list_tags', args: { groupId: 'missing' } }))
      .toThrow('NOT_FOUND')
  })

  it('分组操作走 operation：新建、改名、移动、删除，查询与写入保持一致', async () => {
    const h = fixture()
    h.host.api.create({ tags: { values: ['体态:坐姿', '朝向:前倾'] } })
    const run = async (operation: string, requestId: string, args: Record<string, unknown>) =>
      h.host.api.executeOperation({ operation, requestId, args })

    const created = await run('create_group', 'group-create', { title: '体态', tag: '体态:坐姿' })
    const groupId = created.result as string
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toMatchObject([{ id: groupId, title: '体态', tagCount: 1 }])
    expect((await pageOf(h, { query: 'tag-groups.list_tags', args: { groupId } })).items)
      .toMatchObject([{ tag: '体态:坐姿', groupTitle: '体态' }])

    await run('rename_group', 'group-rename', { group: groupId, title: '体态与姿态' })
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toMatchObject([{ title: '体态与姿态' }])
    await expect(run('create_group', 'group-duplicate', { title: '体态与姿态' })).rejects.toThrow('同名')

    await run('move_tag', 'group-move', { tag: '体态:坐姿', group: null })
    expect((await pageOf(h, { query: 'tag-groups.list_tags', args: { groupId: null } })).items)
      .toMatchObject([{ tag: '体态:坐姿', groupId: null }, { tag: '朝向:前倾', groupId: null }])

    await run('move_tag', 'group-move-back', { tag: '体态:坐姿', group: groupId })
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toMatchObject([{ tagCount: 1 }])

    await run('delete_group', 'group-delete', { group: groupId })
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toEqual([])
    expect((await pageOf(h, { query: 'tag-groups.list_tags' })).items)
      .toMatchObject([{ tag: '体态:坐姿', groupId: null }, { tag: '朝向:前倾', groupId: null }])
  })

  it('旧库有多份分组记录时，只在显式导入后查询最早的一份', async () => {
    const h = fixture()
    const first = await h.host.api.create({ tagGroups: { groups: [{ id: 'first', title: '主目录', tags: ['主题'] }] } })
    await h.host.api.create({ tagGroups: { groups: [{ id: 'later', title: '旧目录', tags: ['旧标签'] }] } })
    h.host.lib.db.prepare('UPDATE entity SET created_at = 1 WHERE id = ?').run(first)
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toEqual([])
    await h.host.api.executeOperation({ operation: 'import_legacy_groups', requestId: 'explicit-legacy-import', args: {} })
    expect((await pageOf(h, { query: 'tag-groups.list_groups' })).items).toEqual([{ id: 'first', title: '主目录', tagCount: 1 }])
    h.host.api.run('tag-groups', 'renameGroup', { group: 'first', title: '新主目录' })
    expect((await pageOf(h, { query: 'tag-groups.list_tags' })).items).toEqual([{ tag: '主题', materialCount: 0, groupId: 'first', groupTitle: '新主目录' }])
  })

  it('数量排除回收站，分页覆盖完整词表，写入后旧游标失效', async () => {
    const h = fixture()
    h.host.api.create({ tags: { values: ['A', 'B'] } })
    const removed = await h.host.api.create({ tags: { values: ['A', '回收站独有'] } })
    await h.host.api.trash([removed])
    const first = await pageOf(h, { query: 'tag-groups.list_tags', limit: 1 })
    const second = await pageOf(h, { query: 'tag-groups.list_tags', limit: 1, cursor: first.nextCursor! })
    expect([...first.items, ...second.items]).toEqual([
      { tag: 'A', materialCount: 1, groupId: null, groupTitle: null },
      { tag: 'B', materialCount: 1, groupId: null, groupTitle: null }
    ])
    expect(second.nextCursor).toBeNull()
    h.host.api.run('tag-groups', 'createGroup', { title: '主题', tag: 'A' })
    expect(() => h.host.api.executeQuery({ query: 'tag-groups.list_tags', limit: 1, cursor: first.nextCursor! })).toThrow('STALE_CURSOR')
  })
})
