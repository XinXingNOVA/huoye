// 自定义字段插件（设计文档 11.4）：模板是身份，每个模板定义一种数据块；
// 定义出来的数据块和插件的一样，能写、能筛选、能分面、能按它分列、能放入视图。

import { afterEach, describe, expect, it } from 'vitest'
import type { BlockKind } from '../../src/shared/blocks'
import type { Query } from '../../src/shared/query'
import { templateKindId, type FieldSpec } from '../fixtures/legacy-fields/blocks'
import { groupableFields } from '@test-plugins/kanban/columns'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { openHost } from '../helpers/helpers'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup(root?: string) {
  const h = openHost(undefined, undefined, root)
  cleanups.push(h.cleanup)
  return h
}

const ids = (r: unknown) => (r as { ids: string[] }).ids

const FILM: FieldSpec[] = [
  { id: 'fshot', title: '镜头', type: 'select', options: ['推', '拉', '摇'] },
  { id: 'frate', title: '评分', type: 'rating' },
  { id: 'fname', title: '片名', type: 'text' },
  { id: 'fmood', title: '情绪', type: 'multi', options: ['紧张', '温暖'] }
]

/** 新建模板：一个身份，挂一块模板块。 */
function createTemplate(host: ReturnType<typeof setup>['host'], title = '影视片段', fields = FILM) {
  const id = host.api.create({ template: { title, fields } }) as string
  return { id, kind: templateKindId(id) }
}

describe('模板定义数据块', () => {
  it('新建模板：注册一种数据块，通知界面', () => {
    const { host, events } = setup()
    const { kind } = createTemplate(host)
    const def = host.reg.kind(kind)!
    expect(def).toMatchObject({ title: '影视片段', plugin: 'fields', rebuildable: false })
    expect(Object.keys(def.fields)).toEqual(['fshot', 'frate', 'fname', 'fmood'])
    expect(def.fields.fshot).toMatchObject({ type: 'enum', options: ['推', '拉', '摇'], index: true })
    expect(def.fields.frate).toMatchObject({ type: 'number', format: 'rating', min: 1, max: 5 })
    expect((host.api.kinds() as BlockKind[]).map((k) => k.id)).toEqual([kind])
    expect(events.some((e) => e.event === 'kinds')).toBe(true)
    // 模板身份不是素材，不出现在"全部"里
    expect(ids(host.api.query({}))).toEqual([])
  })

  it('写坏的模板被拒绝', () => {
    const { host } = setup()
    expect(() => host.api.create({ template: { title: '', fields: [] } })).toThrow(/名称/)
    expect(() => host.api.create({ template: { title: 'x', fields: [FILM[0], FILM[0]] } })).toThrow(/重复/)
    expect(() => host.api.create({ template: { title: 'x', fields: [{ id: 'fab', title: 'a', type: 'formula' }] } })).toThrow(/未知的字段类型/)
    expect(() => host.api.create({ template: { title: 'x', fields: [{ id: 'fab', title: 'a', type: 'select', options: ['推', '推'] }] } })).toThrow(/重复的选项/)
  })

  it('挂上模板、填字段：按字段类型校验', async () => {
    const { host } = setup()
    const { kind } = createTemplate(host)
    const [v] = await host.api.ingest([{ type: 'text', text: '一段镜头' }])
    host.api.put(v, kind, { fshot: '推', frate: 4, fname: '花样年华', fmood: ['温暖'] })
    expect(host.store.blocksOf(v)[kind].data).toEqual({ fshot: '推', frate: 4, fname: '花样年华', fmood: ['温暖'] })
    expect(() => host.api.put(v, kind, { fshot: '跟' })).toThrow(/不是有效的 enum/)
    expect(() => host.api.put(v, kind, { frate: 6 })).toThrow(/不是有效的 number/)
  })

  it('能筛选、能分面、能排序、能按单选分列', async () => {
    const { host } = setup()
    const { kind } = createTemplate(host)
    const [a, b, c] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
      { type: 'text', text: '三' }
    ])
    host.api.put(a, kind, { fshot: '推', frate: 3 })
    host.api.put(b, kind, { fshot: '推', frate: 5 })
    host.api.put(c, kind, { fshot: '摇' })
    expect(ids(host.api.query({ where: [{ op: 'eq', kind, field: 'fshot', value: '推' }] })).sort()).toEqual([a, b].sort())
    expect(ids(host.api.query({ where: [{ op: 'range', kind, field: 'frate', min: 4 }] }))).toEqual([b])
    expect(ids(host.api.query({ has: [kind], sort: { kind, field: 'frate' }, dir: 'desc' }))).toEqual([b, a, c])
    expect(host.api.facet(kind, 'fshot')).toEqual([
      { value: '推', count: 2 },
      { value: '摇', count: 1 }
    ])
    // 看板：模板的单选字段和插件的一样，可以分列
    const kinds = [...corePlugins.flatMap((p) => p.blocks ?? []), ...host.reg.definedKinds()]
    expect(groupableFields(kinds).map((f) => f.key)).toContain(`${kind}.fshot`)
  })

  it('改模板：加字段、改名，定义跟着变，旧数据不动', async () => {
    const { host } = setup()
    const { id, kind } = createTemplate(host)
    const [v] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.put(v, kind, { fshot: '推' })
    const fields = [{ ...FILM[0], title: '运镜' }, ...FILM.slice(1), { id: 'fyear', title: '年份', type: 'number' }]
    host.api.put(id, 'template', { title: '电影片段', fields })
    const def = host.reg.kind(kind)!
    expect(def.title).toBe('电影片段')
    expect(def.fields.fshot.title).toBe('运镜')
    host.api.put(v, kind, { ...host.store.blocksOf(v)[kind].data, fyear: 2000 })
    expect(host.store.blocksOf(v)[kind].data).toEqual({ fshot: '推', fyear: 2000 })
  })

  it('重新打开素材库：模板定义还在', async () => {
    const first = setup()
    const { kind } = createTemplate(first.host)
    const [v] = await first.host.api.ingest([{ type: 'text', text: '一' }])
    first.host.api.put(v, kind, { fshot: '拉' })
    first.host.close()
    cleanups = []
    const second = setup(first.root)
    expect(second.host.reg.kind(kind)?.title).toBe('影视片段')
    expect(ids(second.host.api.query({ where: [{ op: 'eq', kind, field: 'fshot', value: '拉' }] }))).toEqual([v])
  })

  it('兼容旧版已移除模板：已经填的数据照样能读写，新入口拒绝回收站操作', async () => {
    const { host } = setup()
    const { id, kind } = createTemplate(host)
    const [v] = await host.api.ingest([{ type: 'text', text: '一' }])
    expect(() => host.api.trash([id])).toThrow(/管理记录/)
    host.store.setDeletedAt(id, Date.now()) // 旧库状态
    expect(host.reg.kind(kind)).toBeDefined()
    host.api.put(v, kind, { fshot: '推' })
    expect(ids(host.api.query({ has: [kind] }))).toEqual([v])
  })
})

describe('放入"有模板"的视图：挂上空模板', () => {
  it('没有的挂上一块空的，已有的不动；字段条件一起写', async () => {
    const { host } = setup()
    const { kind } = createTemplate(host)
    const [a, b] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' }
    ])
    host.api.put(b, kind, { fshot: '摇', frate: 2 })

    const table: Query = { has: [kind] }
    expect(await host.api.admit([a, b], table)).toEqual({ accepted: [a, b], rejected: [] })
    expect(host.store.blocksOf(a)[kind].data).toEqual({})
    expect(host.store.blocksOf(b)[kind].data).toEqual({ fshot: '摇', frate: 2 })

    const push: Query = { has: [kind], where: [{ op: 'eq', kind, field: 'fshot', value: '推' }] }
    const [c] = await host.api.ingest([{ type: 'text', text: '三' }])
    expect(await host.api.admit([c], push)).toEqual({ accepted: [c], rejected: [] })
    expect(host.store.blocksOf(c)[kind].data).toEqual({ fshot: '推' })
  })

  it('插件的数据块仍然只检查', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '一' }])
    expect(await host.api.admit([t], { has: ['note'] })).toEqual({ accepted: [], rejected: [{ id: t, reason: '有笔记' }] })
  })
})

describe('patch：在核心进程里合并字段', () => {
  it('只改给出的字段；null 清空；模板块空了也留着，插件的数据块空了就移除', async () => {
    const { host } = setup()
    const { kind } = createTemplate(host)
    const [v] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.patch(v, kind, { fshot: '推' })
    host.api.patch(v, kind, { frate: 5 })
    expect(host.store.blocksOf(v)[kind].data).toEqual({ fshot: '推', frate: 5 })
    host.api.patch(v, kind, { fshot: null, frate: null })
    expect(host.store.blocksOf(v)[kind].data).toEqual({})
    host.api.patch(v, 'status', { value: '进行中' })
    host.api.patch(v, 'status', { value: null })
    expect(host.store.blocksOf(v).status).toBeUndefined()
  })
})

describe('模板编辑命令：各入口只提交意图', () => {
  it('相继编辑从最新模板合并，稳定 ID、已有值和其他字段保留；逐项撤销重做', () => {
    const { host } = setup()
    const { template, kind } = host.api.run('fields', 'createTemplate', { title: '  资料  ' }) as { template: string; kind: string }
    const add = (title: string, type: string) =>
      (host.api.run('fields', 'addField', { template, title, type }) as { field: string }).field
    // 模拟两个入口基于同一屏幕内容提交添加意图：第二个命令不能覆盖第一个字段。
    const a = add('阶段', 'select')
    const b = add('备注', 'text')
    expect(a).not.toBe(b)
    const item = host.api.create({ text: { content: '素材' }, [kind]: { [b]: '已有记录' } }) as string
    host.api.run('fields', 'renameTemplate', { template, title: '新资料' })
    host.api.run('fields', 'renameField', { template, field: a, title: '进度' })
    host.api.run('fields', 'addOption', { template, field: a, option: '待办' })
    host.api.run('fields', 'addOption', { template, field: a, option: '完成' })
    host.api.run('fields', 'addOption', { template, field: a, option: ' 完成 ' })
    expect(host.reg.kind(kind)).toMatchObject({ title: '新资料', fields: {
      [a]: { title: '进度', options: ['待办', '完成'] }, [b]: { title: '备注' }
    } })
    expect(host.store.blocksOf(item)[kind].data).toEqual({ [b]: '已有记录' })
    // 重复选项不制造额外历史；一次撤销只撤回最新选项。
    expect(host.api.undo()).toBe('添加选项「完成」')
    expect(host.reg.kind(kind)!.fields[a].options).toEqual(['待办'])
    host.api.redo()
    expect(host.reg.kind(kind)!.fields[a].options).toEqual(['待办', '完成'])
  })

  it('失效字段、类型不合适和空名称被拒绝，预演及失败不写数据或污染历史', () => {
    const { host } = setup()
    const { id: template, kind } = createTemplate(host)
    const before = host.store.blocksOf(template).template.data
    const preview = host.api.preview('fields', 'addField', { template, title: '预演字段', type: 'text' }) as { field: string }
    expect(preview.field).toBeTruthy()
    expect(host.reg.kind(kind)!.fields[preview.field]).toBeUndefined()
    for (const [command, args] of [
      ['addField', { title: '公式', type: 'formula' }],
      ['addField', { title: ' ', type: 'text' }],
      ['renameField', { field: 'missing', title: '失效' }],
      ['renameTemplate', { title: ' ' }],
      ['addOption', { field: 'fname', option: '不是选项' }],
      ['addOption', { field: 'fshot', option: ' ' }]
    ] as const) {
      expect(() => host.api.run('fields', command, { template, ...args })).toThrow()
    }
    expect(host.store.blocksOf(template).template.data).toEqual(before)
    expect(host.api.undo()).toBe('新建模板「影视片段」')
    expect(host.reg.kind(kind)).toBeUndefined()
    host.api.redo()
    expect(host.reg.kind(kind)!.fields.fshot.options).toEqual(['推', '拉', '摇'])
  })

  it('命令新建模板及字段也遵守定义先于数据的撤销和重做', () => {
    const { host } = setup()
    const { template, kind } = host.api.run('fields', 'createTemplate', { title: '新模板' }) as { template: string; kind: string }
    const { field } = host.api.run('fields', 'addField', { template, title: '文本', type: 'text' }) as { field: string }
    expect(host.reg.kind(kind)!.fields[field]).toBeDefined()
    expect(host.api.undo()).toBe('新建字段「文本」')
    expect(host.reg.kind(kind)!.fields).toEqual({})
    expect(host.api.undo()).toBe('新建模板「新模板」')
    expect(host.reg.kind(kind)).toBeUndefined()
    host.api.redo()
    host.api.redo()
    expect(host.reg.kind(kind)!.fields[field]).toMatchObject({ type: 'text', title: '文本' })
  })
})
