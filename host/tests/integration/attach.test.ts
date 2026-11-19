// 快速附加（设计文档 11.5）：建议由数据块定义生成；应用一条建议 = 放入它的查询。
// 配方就是带写入条件的视图。

import { afterEach, describe, expect, it } from 'vitest'
import type { BlockKind } from '../../src/shared/blocks'
import type { Query } from '../../src/shared/query'
import { suggest, valueFields, type AttachContext } from '../../src/renderer/src/quick-attach'
import { templateKind, type FieldSpec } from '../fixtures/legacy-fields/blocks'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { openHost } from '../helpers/helpers'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

const FILM: FieldSpec[] = [
  { id: 'fshot', title: '镜头', type: 'select', options: ['推', '拉'] },
  { id: 'frate', title: '评分', type: 'rating' },
  { id: 'fname', title: '片名', type: 'text' },
  { id: 'fnote', title: '备注', type: 'longtext' }
]
const film = templateKind('T1', { title: '影视片段', fields: FILM })
const kinds: BlockKind[] = [...corePlugins.flatMap((p) => p.blocks ?? []), film]
const kindOf = (id: string) => kinds.find((k) => k.id === id)
const tag = (value: string) => ({ op: 'eq' as const, kind: 'tags', field: 'values', value })

const ctx = (over: Partial<AttachContext> = {}): AttachContext => ({
  kinds,
  values: { 'tags.values': ['配色', '光影'], [`${film.id}.fname`]: ['花样年华'] },
  views: [
    { id: 'v1', title: '待剪片段', query: { has: [film.id], where: [tag('待剪辑'), { op: 'eq', kind: 'status', field: 'value', value: '待处理' }] } },
    { id: 'v2', title: 'MP4 视频', query: { has: ['video'], where: [{ op: 'eq', kind: 'file', field: 'ext', value: 'mp4' }] } }
  ],
  kindOf,
  ...over
})

const labels = (input: string, c = ctx()) => suggest(input, c).map((s) => s.label)

describe('快速附加的建议', () => {
  it('单选：输入选项的一部分', () => {
    expect(labels('进行')[0]).toBe('状态：进行中')
  })

  it('标签：已有的值，或者新建', () => {
    expect(labels('配色')[0]).toBe('标签：配色')
    expect(labels('配色')).not.toContain('标签：新建「配色」')
    expect(labels('待剪辑')).toContain('标签：新建「待剪辑」')
  })

  it('模板：挂上；模板的字段带模板名', () => {
    expect(labels('影视')[0]).toBe('挂上「影视片段」')
    expect(labels('镜头 推')[0]).toBe('影视片段 · 镜头：推')
    expect(labels('片名 一代宗师')[0]).toBe('影视片段 · 片名：一代宗师')
    expect(labels('花样')[0]).toBe('影视片段 · 片名：花样年华')
  })

  it('数字：字段名后面跟数字，超出范围的不给', () => {
    expect(labels('评分 4')[0]).toBe('影视片段 · 评分：★★★★')
    expect(labels('评分 9').some((l) => l.includes('评分'))).toBe(false)
  })

  it('配方：带写入条件的视图；只有准入条件的视图不算', () => {
    expect(labels('待剪片段')[0]).toBe('放入「待剪片段」')
    expect(labels('MP4')).not.toContain('放入「MP4 视频」')
  })

  it('什么都没输入：模板、配方、状态、常用标签；不出现视图块、模板块这类独立数据块', () => {
    const all = labels('', ctx())
    expect(all).toContain('挂上「影视片段」')
    expect(all).toContain('放入「待剪片段」')
    expect(all).toContain('状态：进行中')
    expect(all).toContain('标签：配色')
    expect(all.some((l) => l.startsWith('名称'))).toBe(false)
    expect(all.some((l) => l.includes('镜头'))).toBe(false)
  })

  it('长文本不能附加；要取已有值的只是文本字段', () => {
    expect(labels('备注 好看').some((l) => l.includes('备注'))).toBe(false)
    expect(valueFields(kinds).map((f) => `${f.kind}.${f.field}`)).toEqual(['tags.values', `${film.id}.fname`])
  })
})

describe('应用建议 = 放入它的查询（批量）', () => {
  it('状态、标签、挂模板、填模板字段、放入配方', async () => {
    const h = openHost()
    cleanup = h.cleanup
    const { host } = h
    const tpl = host.api.create({ template: { title: '影视片段', fields: FILM } }) as string
    const live = host.reg.kind(`tpl:${tpl}`)!
    const [a, b] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' }
    ])
    const c = ctx({ kinds: [...corePlugins.flatMap((p) => p.blocks ?? []), live], views: [] })
    const apply = async (input: string) => {
      const s = suggest(input, c)[0]
      return host.api.admit([a, b], s.query as Query)
    }

    await apply('进行')
    await apply('待剪辑')
    await apply('镜头 推')
    for (const id of [a, b]) {
      const blocks = host.store.blocksOf(id)
      expect(blocks.status.data).toEqual({ value: '进行中' })
      expect(blocks.tags.data).toEqual({ values: ['待剪辑'] })
      // 填模板字段时没挂模板的顺便挂上
      expect(blocks[live.id].data).toEqual({ fshot: '推' })
    }

    const recipe: Query = { has: [live.id], where: [tag('精选'), { op: 'eq', kind: 'status', field: 'value', value: '已完成' }] }
    const withRecipe = ctx({ kinds: c.kinds, views: [{ id: 'v', title: '精选片段', query: recipe }] })
    const s = suggest('精选片段', withRecipe)[0]
    expect(s.label).toBe('放入「精选片段」')
    expect(await host.api.admit([a], s.query)).toEqual({ accepted: [a], rejected: [] })
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['待剪辑', '精选'])
    expect(host.store.blocksOf(a).status.data.value).toBe('已完成')
  })
})
