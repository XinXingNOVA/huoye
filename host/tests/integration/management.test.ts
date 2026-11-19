import { afterEach, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Host } from '../../src/core/host'
import { corePlugins } from '../../src/plugins/core'
import { openHost } from '../helpers/helpers'
import type { Query } from '../../src/shared/query'
import type { BlockKind } from '../../src/shared/blocks'
import { legacyCorePlugins } from '../helpers/legacy-plugins'

let current: ReturnType<typeof openHost> | undefined
const setup = () => (current = openHost()).host
const reopen = () => {
  const root = current!.root
  current!.host.close()
  return (current = openHost(undefined, undefined, root)).host
}
afterEach(async () => { await current?.host.scheduler.idle(); current?.cleanup(); current = undefined })
const ids = (h: Host, q: Query) => (h.api.query(q) as { ids: string[] }).ids
const template = (h: Host) => h.api.create({ template: { title: '研究', fields: [{ id: 'fvalue', title: '说明', type: 'text' }] } }) as string

it('旧内容块升级为容器后保留既有附加值，停用与重开仍按容器查询和约束写入', async () => {
  const original: BlockKind = { id: 'cabinet', plugin: 'note', version: 1, title: '资料柜', content: true, rebuildable: false, fields: { title: { type: 'text', title: '名称' } } }
  const upgraded = { ...original, version: 2, container: true }
  const caption: BlockKind = { id: 'cabinet-caption', plugin: 'note', title: '说明', version: 1, rebuildable: false, allowOnContainer: true, fields: { text: { type: 'text', title: '说明' } } }
  const plugins = (next: boolean) => legacyCorePlugins.map(p => p.id !== 'note' ? p : {
    ...p, blocks: [...p.blocks ?? [], ...(next ? [upgraded, caption] : [original])],
    compatibleSchemas: next ? [original] : []
  })
  current = openHost(plugins(false))
  const folder = current.host.api.create({ cabinet: { title: '灵感' }, status: { value: '待处理' } }) as string
  const oldStatus = current.host.store.blocksOf(folder).status
  const other = current.host.api.create({ text: { content: '海报' } }) as string
  const root = current.root
  await current.host.scheduler.idle(); current.host.close()
  current = openHost(plugins(true), undefined, root)
  const h = current.host
  expect(h.store.blocksOf(folder).status).toEqual(oldStatus)
  expect(h.store.blocksOf(folder).cabinet.ver).toBe(2)
  h.api.put(folder, 'cabinet', { title: '参考' })
  h.api.put(folder, caption.id, { text: '布局备选' })
  expect(h.store.blocksOf(folder)[caption.id].data.text).toBe('布局备选')
  expect(() => h.api.put(other, 'cabinet', { title: '混合' })).toThrow('已有素材')
  expect(() => h.api.put(folder, 'status', { value: '进行中' })).toThrow('容器')
  await h.scheduler.idle(); h.close()
  current = openHost(legacyCorePlugins.filter(p => p.id !== 'note'), undefined, root)
  expect(current.host.reg.kind('cabinet')).toMatchObject({ container: true, dormant: true })
  expect(ids(current.host, { role: 'container' })).toEqual([folder])
  expect(ids(current.host, { role: 'material' })).toEqual([other])
  expect(() => current!.host.api.put(folder, 'status', { value: '已完成' })).toThrow('容器')
  current.host.api.trash([folder])
  expect(ids(current.host, { scope: 'trash', role: 'container' })).toEqual([folder])
  current.host.api.restore([folder])
  expect(current.host.store.blocksOf(folder).status).toEqual(oldStatus)
})

it('模板预演不改数据；一次删除活跃和回收站中的字段，原文件与其他块保留，反复撤销重做完整恢复', async () => {
  const h = setup()
  const path = join(current!.root, 'sample.txt'); writeFileSync(path, '不能丢失的原文件')
  const [file] = await h.api.ingest([{ type: 'file', path }])
  await h.scheduler.idle()
  const t = template(h), kind = `tpl:${t}`
  const item = h.api.create({ text: { content: '材料' }, tags: { values: ['保留'] }, [kind]: { fvalue: '已删除素材的字段' } }) as string
  h.api.put(file, kind, { fvalue: '文件上的字段' })
  h.api.put(file, 'note', { text: '保留笔记' })
  h.api.trash([item])
  const before = h.store.get([file, item, t])
  expect(h.api.preview('fields', 'deleteTemplate', { template: t })).toEqual({ affected: 2 })
  expect(h.store.get([file, item, t])).toEqual(before)
  expect(h.api.run('fields', 'deleteTemplate', { template: t, expectedAffected: 2 })).toEqual({ affected: 2 })
  expect(h.store.get([t])).toEqual([])
  expect(h.reg.kind(kind)).toBeUndefined()
  for (const id of [file, item]) expect(h.store.blocksOf(id)[kind]).toBeUndefined()
  expect(h.store.blocksOf(file).note.data.text).toBe('保留笔记')
  expect(h.store.blocksOf(item).tags.data.values).toEqual(['保留'])
  expect(ids(h, { scope: 'trash' })).toEqual([item])
  expect(readFileSync(h.lib.files.readable(String(h.store.blocksOf(file).file.data.path)), 'utf8')).toBe('不能丢失的原文件')
  for (let n = 0; n < 2; n++) {
    h.api.undo()
    expect(h.reg.kind(kind)?.title).toBe('研究')
    expect(h.store.get([t])[0].createdAt).toBe(before[2].createdAt)
    expect(h.store.blocksOf(file)[kind].data).toEqual({ fvalue: '文件上的字段' })
    expect(h.store.blocksOf(item)[kind].data).toEqual({ fvalue: '已删除素材的字段' })
    expect(h.store.isTrashed(item)).toBe(true)
    expect(ids(h, { search: [{ text: '文件上的字段', kind }] })).toEqual([file])
    h.api.redo()
    expect(h.store.exists(t)).toBe(false)
  }
})

it('混合选择不能绕过管理角色；创建、附加、批量写入、移除和回收均不产生部分改动', async () => {
  const h = setup(), t = template(h)
  const item = h.api.create({ text: { content: '材料' } }) as string
  const before = h.store.get([item, t])
  expect(() => h.api.create({ text: { content: '混合' }, template: { title: '错误', fields: [] } })).toThrow(/管理记录/)
  expect(() => h.api.put(t, 'tags', { values: ['错误'] })).toThrow(/管理记录/)
  expect(() => h.api.patch(t, 'note', { text: '错误' })).toThrow(/管理记录/)
  expect(() => h.api.put(item, 'template', { title: '错误', fields: [] })).toThrow(/管理记录/)
  expect(() => h.api.remove(t, 'template')).toThrow(/管理记录/)
  expect(() => h.api.apply([item, t], [{ op: 'eq', kind: 'tags', field: 'values', value: '错误' }])).toThrow(/管理记录/)
  await expect(h.api.admit([item, t], { scope: 'all', where: [{ op: 'eq', kind: 'tags', field: 'values', value: '错误' }] })).rejects.toThrow(/管理记录/)
  expect(() => h.api.trash([item, t])).toThrow(/管理记录/)
  expect(() => h.api.restore([t])).toThrow(/管理记录/)
  expect(h.store.get([item, t])).toEqual(before)
  expect(() => h.api.run('tags', 'update', { ids: [item, t], add: ['错误'], remove: [] })).toThrow(/NOT_FOUND/)
})

it('最后一个分组删除即清理容器，建组撤销也无空身份；素材标签不变', () => {
  const h = setup()
  const item = h.api.create({ text: { content: '材料' }, tags: { values: ['配色'] } }) as string
  const g = h.api.run('tags', 'createGroup', { title: '主题', tag: '配色' })
  const [record] = ids(h, { scope: 'all', role: 'management' })
  h.api.run('tags', 'deleteGroup', { group: g })
  expect(h.store.exists(record)).toBe(false)
  expect(ids(h, { scope: 'trash', role: 'management' })).toEqual([])
  expect(h.store.blocksOf(item).tags.data.values).toEqual(['配色'])
  h.api.undo()
  expect(h.store.blocksOf(record).tagGroups.data.groups).toEqual([{ id: g, title: '主题', tags: ['配色'] }])
  h.api.undo()
  expect(h.store.exists(record)).toBe(false)
  expect(ids(h, { scope: 'trash' })).toEqual([])
  h.api.redo(); h.api.redo()
  expect(h.store.exists(record)).toBe(false)
})

it('保存视图删除和撤销只改变配置，删除后重启不复活', () => {
  let h = setup()
  const item = h.api.create({ text: { content: '材料' } }) as string
  const view = h.api.create({ view: { title: '我的视图', query: {}, layout: 'masonry' } }) as string
  h.api.run('view', 'deleteView', { id: view })
  expect(h.store.exists(view)).toBe(false)
  h.api.undo(); expect(h.store.blocksOf(view).view.data.title).toBe('我的视图')
  h.api.redo()
  h = reopen()
  expect(ids(h, { scope: 'all' })).toEqual([item])
  expect(h.api.undo()).toBeNull()
})

it('旧版已移除模板和误附加数据可一次处理；撤销恢复旧状态，素材搜索和分面排除管理记录', () => {
  const h = setup(), t = template(h)
  h.store.put(t, 'tags', { values: ['旧误标签'] }, true)
  h.store.setDeletedAt(t, 123)
  const item = h.api.create({ text: { content: '材料' }, [`tpl:${t}`]: { fvalue: '旧值' } }) as string
  expect(ids(h, { scope: 'trash' })).toEqual([])
  expect(ids(h, { scope: 'trash', role: 'management' })).toEqual([t])
  expect(h.api.facet('tags', 'values')).toEqual([])
  h.api.run('fields', 'deleteTemplate', { template: t })
  expect(h.store.exists(t)).toBe(false)
  h.api.undo()
  expect(h.store.get([t])[0].deletedAt).toBe(123)
  expect(h.store.blocksOf(t).tags.data.values).toEqual(['旧误标签'])
  expect(h.store.blocksOf(item)[`tpl:${t}`].data.fvalue).toBe('旧值')
})

it('旧空容器自动清理但插件停用时保留；旧快照也能识别管理角色', () => {
  let h = setup()
  const empty = h.api.create({ tagGroups: { groups: [] } }) as string
  h.api.setPlugins(['tags', 'fields'])
  const t = template(h)
  const raw = JSON.parse(h.lib.db.prepare('SELECT def FROM main.kind_def WHERE id = ?').pluck().get('template') as string)
  delete raw.management
  h.lib.db.prepare('UPDATE main.kind_def SET def = ? WHERE id = ?').run(JSON.stringify(raw), 'template')
  h = reopen()
  expect(h.store.exists(empty)).toBe(true)
  expect(h.reg.kind('template')?.management).toEqual({})
  expect(ids(h, { scope: 'all', role: 'management' }).sort()).toEqual([t, empty].sort())
  expect(() => h.api.put(t, 'tags', { values: ['错误'] })).toThrow()
  expect(() => h.api.run('fields', 'deleteTemplate', { template: t })).toThrow(/没有命令/)
  h.api.setPlugins([]); h = reopen()
  expect(h.store.exists(empty)).toBe(false)
  expect(h.store.exists(t)).toBe(true)
})

it('预演后数量变化时要求重新查看影响，失败的删除整体回滚', () => {
  const h = setup(), t = template(h), kind = `tpl:${t}`
  const item = h.api.create({ text: { content: '材料' }, [kind]: { fvalue: '保留' } }) as string
  expect(() => h.api.run('fields', 'deleteTemplate', { template: t, expectedAffected: 0 })).toThrow(/数量已变化/)
  // 旧库曾把内容和配置混用，自动删除不能伤到内容。
  h.store.put(t, 'text', { content: '旧内容' }, true)
  expect(() => h.api.run('fields', 'deleteTemplate', { template: t })).toThrow(/含有内容/)
  expect(h.store.blocksOf(item)[kind].data.fvalue).toBe('保留')
  expect(h.reg.kind(kind)).toBeDefined()
  expect(h.store.blocksOf(t).text.data.content).toBe('旧内容')
})

it('删除模板后彻底删除一个素材，撤销模板删除不会复活那个素材', async () => {
  const h = setup(), t = template(h), kind = `tpl:${t}`
  const item = h.api.create({ text: { content: '材料' }, [kind]: { fvalue: '值' } }) as string
  h.api.trash([item]); h.api.run('fields', 'deleteTemplate', { template: t })
  await h.api.purge([item])
  h.api.undo()
  expect(h.store.exists(t)).toBe(true)
  expect(h.store.exists(item)).toBe(false)
  expect(h.store.blocksOf(item)).toEqual({})
})

it('管理删除只能作用于所属插件，原文件和依附内容不会被误删', () => {
  const h = setup(), t = template(h)
  const test = corePlugins.find(p => p.id === 'view')!
  test.commands!.testWrongOwner = (ctx) => { ctx.deleteRecord(t); return { label: '错误' } }
  try { expect(() => h.api.run('view', 'testWrongOwner', {})).toThrow(/本插件/) }
  finally { delete test.commands!.testWrongOwner }
  h.api.create({ anchor: { target: t, type: '文本区间', quote: '依附内容' } })
  expect(() => h.api.run('fields', 'deleteTemplate', { template: t })).toThrow(/依附内容/)
  expect(h.store.exists(t)).toBe(true)
})

it('旧管理记录上休眠的误附加数据也能随删除一起撤销', () => {
  let h = setup()
  const t = template(h)
  h.store.put(t, 'tags', { values: ['旧标签'] }, true)
  h.api.setPlugins(['tags']); h = reopen()
  h.api.run('fields', 'deleteTemplate', { template: t })
  h.api.undo()
  expect(h.store.blocksOf(t).tags.data.values).toEqual(['旧标签'])
  h.api.redo()
  expect(h.store.exists(t)).toBe(false)
})

it('命令内新建后删除的临时管理记录不污染历史或复活空身份', () => {
  const h = setup()
  let id = ''
  h.history.run('临时记录', () => {
    id = h.store.createEntity()
    h.store.put(id, 'view', { title: '临时', query: {} })
    h.store.deleteRecord(id, 'view')
  })
  expect(h.store.exists(id)).toBe(false)
  expect(h.api.undo()).toBeNull()
  expect(h.api.redo()).toBeNull()
})
