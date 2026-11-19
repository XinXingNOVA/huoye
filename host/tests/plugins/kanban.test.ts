// 看板：每一列是"字段等于某值"的视图，"未设置"一列是"字段为空"的视图；换列 = 放入视图。

import { afterEach, describe, expect, it } from 'vitest'
import { describeCondition, splitConditions, type Query } from '../../src/shared/query'
import { columnsFor, groupableFields, resolveGroupField } from '@test-plugins/kanban/columns'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { Registry } from '../../src/core/registry'
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

const ids = (r: unknown) => (r as { ids: string[] }).ids
const reg = new Registry(corePlugins)
const kindOf = (k: string) => reg.kind(k)
const blockKinds = corePlugins.flatMap((p) => p.blocks ?? [])

describe('看板的列', () => {
  it('能分列的字段：单选和是 / 否，可写的在前', () => {
    const fields = groupableFields(blockKinds)
    expect(fields[0]).toMatchObject({ key: 'status.value', readonly: false })
    expect(fields.map((f) => f.key)).toContain('audioPlayback.finished')
    // 可重建数据上的字段只能看
    expect(fields.find((f) => f.key === 'image.animated')?.readonly).toBe(true)
    // 标签是列表、格式是自由文本：不能分列
    expect(fields.some((f) => f.kind === 'tags' || f.key === 'file.ext')).toBe(false)
    expect(resolveGroupField(fields, 'nope.nope')?.key).toBe('status.value')
  })

  it('列：未设置 + 声明的取值', () => {
    const status = resolveGroupField(groupableFields(blockKinds), 'status.value')!
    const cols = columnsFor(status, blockKinds)
    expect(cols.map((c) => c.title)).toEqual(['未设置', '待处理', '进行中', '已完成', '搁置'])
    expect(cols[0].cond).toEqual({ op: 'empty', kind: 'status', field: 'value' })
    const finished = resolveGroupField(groupableFields(blockKinds), 'audioPlayback.finished')!
    expect(columnsFor(finished, blockKinds).map((c) => c.title)).toEqual(['未设置', '否', '是'])
  })

  it('"为空"：单值字段可以写（改成空），列表字段只能检查', () => {
    const empty = { op: 'empty' as const, kind: 'status', field: 'value' }
    expect(splitConditions({ where: [empty] }, kindOf)?.write).toEqual([empty])
    const noTags = { op: 'empty' as const, kind: 'tags', field: 'values' }
    expect(splitConditions({ where: [noTags] }, kindOf)?.check.where).toEqual([noTags])
    expect(describeCondition(empty, kindOf)).toBe('状态为空')
  })
})

describe('换列 = 放入视图', () => {
  const base: Query = { scope: 'content' }
  const col = (value: string): Query => ({ ...base, where: [{ op: 'eq', kind: 'status', field: 'value', value }] })
  const unset: Query = { ...base, where: [{ op: 'empty', kind: 'status', field: 'value' }] }

  it('每一列查出各自的素材，"未设置"是没有状态的', async () => {
    const { host } = setup()
    const [a, b, c] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
      { type: 'text', text: '三' }
    ])
    host.api.put(a, 'status', { value: '进行中' })
    host.api.put(b, 'status', { value: '已完成' })
    expect(ids(host.api.query(col('进行中')))).toEqual([a])
    expect(ids(host.api.query(col('已完成')))).toEqual([b])
    expect(ids(host.api.query(unset))).toEqual([c])
  })

  it('拖到另一列：状态改掉；拖回"未设置"：状态块被移除，留有历史', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    expect(await host.api.admit([a], col('进行中'))).toEqual({ accepted: [a], rejected: [] })
    expect(await host.api.admit([a], col('已完成'))).toEqual({ accepted: [a], rejected: [] })
    expect(ids(host.api.query(col('进行中')))).toEqual([])
    expect(ids(host.api.query(col('已完成')))).toEqual([a])

    expect(await host.api.admit([a], unset)).toEqual({ accepted: [a], rejected: [] })
    expect(host.store.blocksOf(a).status).toBeUndefined()
    expect(ids(host.api.query(unset))).toEqual([a])
    const history = host.lib.db
      .prepare("SELECT data FROM main.block_history WHERE entity_id = ? AND kind = 'status' ORDER BY seq")
      .pluck()
      .all(a)
    expect(history.at(-1)).toBe(JSON.stringify({ value: '已完成' }))
  })

  it('放进同一列不产生新的历史', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    await host.api.admit([a], col('进行中'))
    const count = () => host.lib.db.prepare("SELECT COUNT(*) FROM main.block_history WHERE kind = 'status'").pluck().get()
    const before = count()
    await host.api.admit([a], col('进行中'))
    expect(count()).toBe(before)
  })

  it('看板所在视图的条件一起写上：项目 A 的看板里，从外面拖进"进行中"', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '新的' }])
    const tagA = { op: 'eq' as const, kind: 'tags', field: 'values', value: '项目A' }
    const q: Query = { where: [tagA, { op: 'eq', kind: 'status', field: 'value', value: '进行中' }] }
    expect(await host.api.admit([t], q)).toEqual({ accepted: [t], rejected: [] })
    expect(host.store.blocksOf(t).tags.data.values).toEqual(['项目A'])
    expect(host.store.blocksOf(t).status.data.value).toBe('进行中')
  })

  it('按只读字段分列：换列被拒绝并说明', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '一' }])
    const res = await host.api.admit([t], { where: [{ op: 'eq', kind: 'image', field: 'animated', value: true }] })
    expect(res).toEqual({ accepted: [], rejected: [{ id: t, reason: '动图为「是」' }] })
  })
})
