// 状态插件：单值字段。放入"状态为某值"的视图是"改成"，素材离开原来那个状态的视图。

import { afterEach, describe, expect, it } from 'vitest'
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

const status = (value: string) => ({ op: 'eq' as const, kind: 'status', field: 'value', value })
const ids = (r: unknown) => (r as { ids: string[] }).ids

describe('状态', () => {
  it('只接受预设的几个值', async () => {
    const { host } = setup()
    const [a] = await host.api.ingest([{ type: 'text', text: '一' }])
    host.api.put(a, 'status', { value: '进行中' })
    expect(host.store.blocksOf(a).status.data).toEqual({ value: '进行中' })
    expect(() => host.api.put(a, 'status', { value: '随便写' })).toThrow(/不是有效的 enum/)
  })

  it('放进"进行中"视图：状态被改掉，离开"待处理"视图（看板换列）', async () => {
    const { host } = setup()
    const [a, b] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' }
    ])
    host.api.put(a, 'status', { value: '待处理' })
    host.api.put(b, 'status', { value: '待处理' })
    host.api.put(a, 'tags', { values: ['配色'] })

    const res = await host.api.admit([a], { where: [status('进行中')] })
    expect(res).toEqual({ accepted: [a], rejected: [] })
    expect(host.store.blocksOf(a).status.data.value).toBe('进行中')
    expect(ids(host.api.query({ where: [status('待处理')] }))).toEqual([b])
    expect(ids(host.api.query({ where: [status('进行中')] }))).toEqual([a])
    // 其他数据不受影响
    expect(host.store.blocksOf(a).tags.data.values).toEqual(['配色'])
    // 改状态是手写数据，留有历史，可以追溯
    const history = host.lib.db.prepare("SELECT data FROM main.block_history WHERE entity_id = ? AND kind = 'status' ORDER BY seq").pluck().all(a)
    expect(history).toEqual([null, JSON.stringify({ value: '待处理' })])
  })

  it('准入与写入一起：只有图片才能放进"待剪辑的图片"', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '文字' }])
    const res = await host.api.admit([t], { has: ['image'], where: [status('待处理')] })
    expect(res).toEqual({ accepted: [], rejected: [{ id: t, reason: '有图片' }] })
    expect(host.store.blocksOf(t).status).toBeUndefined()
  })

  it('状态分面按值统计', async () => {
    const { host } = setup()
    const [a, b, c] = await host.api.ingest([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
      { type: 'text', text: '三' }
    ])
    host.api.put(a, 'status', { value: '进行中' })
    host.api.put(b, 'status', { value: '进行中' })
    host.api.put(c, 'status', { value: '已完成' })
    expect(host.api.facet('status', 'value')).toEqual([
      { value: '进行中', count: 2 },
      { value: '已完成', count: 1 }
    ])
  })
})
