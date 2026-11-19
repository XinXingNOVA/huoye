// 加工调度的宿主能力：按身份仲裁、按 System 限并发、按需加工、取消、外部程序检查、历史开关。

import { afterEach, describe, expect, it } from 'vitest'
import type { CorePlugin } from '../../src/core/plugin'
import type { BlockKind } from '../../src/shared/blocks'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { openHost } from '../helpers/helpers'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup(extra: CorePlugin[], opts = {}) {
  const h = openHost([...corePlugins, ...extra], { concurrency: 8, ...opts })
  cleanups.push(h.cleanup)
  return h
}

const kind = (id: string, plugin: string, fields: BlockKind['fields'] = { v: { type: 'number', title: 'v' } }): BlockKind => ({
  id,
  plugin,
  title: id,
  rebuildable: true,
  version: 1,
  fields
})

describe('同一种数据块的多个产出者', () => {
  it('每个身份上只有满足条件、优先级最高的那个写入', async () => {
    const plugin: CorePlugin = {
      id: 'multi',
      version: 1,
      blocks: [kind('out', 'multi')],
      systems: [
        { id: 'multi.a', priority: 1, has: ['text'], match: (b) => String(b.text.data.content).startsWith('a'), outputs: ['out'], run: async () => ({ out: { v: 1 } }) },
        { id: 'multi.b', priority: 2, has: ['text'], outputs: ['out'], run: async () => ({ out: { v: 2 } }) }
      ]
    }
    const { host } = setup([plugin])
    const [a] = await host.api.ingest([{ type: 'text', text: 'a 开头' }])
    const [b] = await host.api.ingest([{ type: 'text', text: 'b 开头' }])
    await host.scheduler.idle()
    expect(host.store.blocksOf(a).out.data).toEqual({ v: 1 })
    expect(host.store.blocksOf(b).out.data).toEqual({ v: 2 })
    const skipped = host.lib.db
      .prepare("SELECT status, error FROM derived.derivation WHERE entity_id = ? AND system = 'multi.b'")
      .get(a) as { status: string; error: string }
    expect(skipped).toEqual({ status: 'skipped', error: '由 multi.a 负责' })
  })

  it('优先级相同的两个产出者无法仲裁，装配时报错', () => {
    const plugin: CorePlugin = {
      id: 'tie',
      version: 1,
      systems: [{ id: 'tie.still', priority: 10, has: ['file'], outputs: ['still'], run: async () => ({}) }]
    }
    expect(() => openHost([...corePlugins, plugin])).toThrow(/优先级相同/)
  })
})

describe('并发、按需、取消', () => {
  it('按 System 限制同时运行的数量', async () => {
    let running = 0
    let peak = 0
    const plugin: CorePlugin = {
      id: 'slow',
      version: 1,
      blocks: [kind('slowout', 'slow')],
      systems: [
        {
          id: 'slow.work',
          priority: 1,
          has: ['text'],
          outputs: ['slowout'],
          concurrency: 2,
          run: async () => {
            peak = Math.max(peak, ++running)
            await new Promise((r) => setTimeout(r, 20))
            running--
            return { slowout: { v: 1 } }
          }
        }
      ]
    }
    const { host } = setup([plugin])
    await host.api.ingest(Array.from({ length: 8 }, (_, i) => ({ type: 'text' as const, text: `第 ${i} 段` })))
    await host.scheduler.idle()
    expect(peak).toBe(2)
    expect((host.api.query({ has: ['slowout'] }) as { ids: string[] }).ids).toHaveLength(8)
  })

  it('按需加工平时不运行，请求后才运行', async () => {
    let runs = 0
    const plugin: CorePlugin = {
      id: 'lazy',
      version: 1,
      blocks: [kind('lazyout', 'lazy')],
      systems: [{ id: 'lazy.make', priority: 1, has: ['text'], outputs: ['lazyout'], demand: true, run: async () => ({ lazyout: { v: ++runs } }) }]
    }
    const { host } = setup([plugin])
    const [id] = await host.api.ingest([{ type: 'text', text: '要用时再做' }])
    await host.scheduler.idle()
    expect(host.store.blocksOf(id).lazyout).toBeUndefined()

    expect(host.api.demand(id, 'lazyout')).toBe(true)
    await host.scheduler.idle()
    expect(host.store.blocksOf(id).lazyout.data).toEqual({ v: 1 })

    // 已是最新时再次请求不会重做
    host.api.demand(id, 'lazyout')
    await host.scheduler.idle()
    expect(runs).toBe(1)
    expect(host.api.demand(id, 'note')).toBe(false)
  })

  it('移到回收站时取消正在运行的加工，不记为失败', async () => {
    let aborted = false
    let started!: () => void
    const startedP = new Promise<void>((r) => (started = r))
    const plugin: CorePlugin = {
      id: 'long',
      version: 1,
      blocks: [kind('longout', 'long')],
      systems: [
        {
          id: 'long.work',
          priority: 1,
          has: ['text'],
          outputs: ['longout'],
          run: (ctx) =>
            new Promise((_, reject) => {
              started()
              ctx.signal.addEventListener('abort', () => {
                aborted = true
                reject(new Error('已取消'))
              })
            })
        }
      ]
    }
    const { host } = setup([plugin])
    const [id] = await host.api.ingest([{ type: 'text', text: '很慢的活' }])
    await startedP
    host.api.trash([id])
    await host.scheduler.idle()
    expect(aborted).toBe(true)
    const row = host.lib.db.prepare("SELECT status FROM derived.derivation WHERE entity_id = ? AND system = 'long.work'").get(id)
    expect(row).toBeUndefined()
  })
})

describe('外部程序', () => {
  it('缺少声明的程序时整个插件不可用，它的加工不运行', async () => {
    let runs = 0
    const plugin: CorePlugin = {
      id: 'needs',
      version: 1,
      requires: { programs: ['definitely-not-installed-xyz'] },
      blocks: [kind('needsout', 'needs')],
      systems: [{ id: 'needs.work', priority: 1, has: ['text'], outputs: ['needsout'], run: async () => ({ needsout: { v: ++runs } }) }]
    }
    const { host } = setup([plugin])
    await host.api.ingest([{ type: 'text', text: '没有程序' }])
    await host.scheduler.idle()
    expect(runs).toBe(0)
    expect((host.api.info() as { unavailable: unknown[] }).unavailable).toContainEqual({
      plugin: 'needs',
      reason: '找不到 definitely-not-installed-xyz'
    })
  })
})

describe('历史版本', () => {
  it('声明不保留历史的数据块（播放进度）写入时不进历史表', async () => {
    const { host } = setup([])
    const [id] = await host.api.ingest([{ type: 'text', text: '一段' }])
    for (let i = 1; i <= 5; i++) host.api.put(id, 'audioPlayback', { position: i * 10, finished: false, plays: 1, lastPlayed: Date.now() })
    host.api.put(id, 'note', { text: '笔记保留历史' })
    const kinds = host.lib.db.prepare('SELECT kind FROM main.block_history WHERE entity_id = ?').pluck().all(id)
    expect(kinds).not.toContain('audioPlayback')
    expect(kinds).toContain('note')
    expect(host.store.blocksOf(id).audioPlayback.data.position).toBe(50)
  })
})


describe('字段输入的加工新鲜度', () => {
  it('列表与布尔输入不会反复加工；值未变不重算，值变化后只补算一次', async () => {
    let runs = 0
    const plugin: CorePlugin = {
      id: 'fieldinput', version: 1,
      blocks: [
        { ...kind('inputdata', 'fieldinput', { values: { type: 'text', title: '值', list: true }, enabled: { type: 'boolean', title: '启用' } }), rebuildable: false },
        kind('inputresult', 'fieldinput')
      ],
      systems: [{ id: 'fieldinput.work', priority: 1, has: ['inputdata'],
        inputs: ['inputdata.values', 'inputdata.enabled'], outputs: ['inputresult'],
        run: async () => ({ inputresult: { v: ++runs } }) }]
    }
    const { host } = setup([plugin])
    const [id] = await host.api.ingest([{ type: 'text', text: '列表输入' }])
    host.api.put(id, 'inputdata', { values: ['红色', '含,逗号和"引号'], enabled: true })
    await host.scheduler.idle()
    expect(runs).toBe(1)
    host.api.put(id, 'inputdata', { values: ['红色', '含,逗号和"引号'], enabled: true })
    await host.scheduler.idle()
    expect(runs).toBe(1)
    host.api.put(id, 'inputdata', { values: [], enabled: false })
    await host.scheduler.idle()
    expect(runs).toBe(2)
  })
})
