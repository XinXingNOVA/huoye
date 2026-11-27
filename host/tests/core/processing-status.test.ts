import { afterEach, expect, it } from 'vitest'
import type { CorePlugin } from '../../src/core/plugin'
import type { BlockKind } from '../../src/shared/blocks'
import { legacyCorePlugins } from '../helpers/legacy-plugins'
import { openHost } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const output = (id: string): BlockKind => ({ id, plugin: 'probe', title: id, rebuildable: true, version: 1, fields: { v: { type: 'number', title: '值' } } })
function setup(systems: CorePlugin['systems'], outputs = ['probe.out'], extra: Partial<CorePlugin> = {}) {
  const h = openHost([...legacyCorePlugins, { id: 'probe', version: 1, blocks: outputs.map(output), systems, ...extra }])
  cleanups.push(h.cleanup)
  return h.host
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('等待本批新输入及上游；旧输出不会掩盖新失败，无关身份不阻塞已完成项', async () => {
  let pause: ReturnType<typeof gate> | undefined
  const host = setup([
    { id: 'probe.first', has: ['text'], outputs: ['probeMid'], priority: 1, run: async (_ctx, _id, blocks) => {
      await pause?.promise
      if (blocks.text.data.content === '失败') throw new Error('模拟加工失败')
      return { 'probeMid': { v: 1 } }
    } },
    { id: 'probe.next', has: ['probeMid'], outputs: ['probe.out'], priority: 2, run: async () => ({ 'probe.out': { v: 2 } }) }
  ], ['probeMid', 'probe.out'])
  const [id] = await host.api.ingest([{ type: 'text', text: '第一版' }])
  const request = { ids: [id], kinds: ['probeMid', 'probe.out'] }
  await host.scheduler.idle()
  const ready = await host.api.processingStatus(request)
  expect(ready.items[0].kinds.map(k => k.state)).toEqual(['ready', 'ready'])
  pause = gate()
  host.api.patch(id, 'text', { content: '失败' })
  const pending = await host.api.processingStatus(request)
  expect(pending.items[0].revision).not.toBe(ready.items[0].revision)
  expect(pending.items[0].kinds.map(k => k.state)).toEqual(['pending', 'pending'])
  expect(pending.items[0].kinds.every(k => k.seq !== undefined)).toBe(true)
  pause.release(); await host.scheduler.idle()
  const failed = await host.api.processingStatus(request)
  expect(failed.items[0].kinds).toMatchObject([{ state: 'failed', reason: '模拟加工失败' }, { state: 'blocked', reason: expect.stringContaining('依赖 probeMid failed') }])
  expect(failed.items[0].revision).toBe(pending.items[0].revision)
  host.api.patch(id, 'text', { content: '恢复' }); await host.scheduler.idle()
  pause = gate()
  await host.api.ingest([{ type: 'text', text: '其他任务' }])
  host.scheduler.rescan()
  expect((await host.api.processingStatus(request)).items[0].kinds.map(k => k.state)).toEqual(['ready', 'ready'])
  pause.release(); await host.scheduler.idle()
})

it('按权威产出者仲裁，并区分无产出、不适用、按需未触发、缺能力与回收项', async () => {
  let lazyRuns = 0
  const host = setup([
    { id: 'probe.special', has: ['text'], outputs: ['probe.out'], priority: 1, match: b => b.text.data.content === '特殊', run: async () => ({ 'probe.out': { v: 1 } }) },
    { id: 'probe.fallback', has: ['text'], outputs: ['probe.out'], priority: 2, run: async () => ({ 'probe.out': { v: 2 } }) },
    { id: 'probe.empty', has: ['text'], outputs: ['probe.empty'], priority: 1, run: async () => ({}) },
    { id: 'probe.skip', has: ['file'], outputs: ['probe.skip'], priority: 1, run: async () => ({}) },
    { id: 'probe.lazy', has: ['text'], outputs: ['probe.lazy'], priority: 1, demand: true, run: async () => ({ 'probe.lazy': { v: ++lazyRuns } }) }
  ], ['probe.out', 'probe.empty', 'probe.skip', 'probe.lazy'])
  const [id] = await host.api.ingest([{ type: 'text', text: '普通' }])
  await host.scheduler.idle()
  const request = { ids: [id], kinds: ['probe.out', 'probe.empty', 'probe.skip', 'probe.lazy', 'unknown'] }
  const states = (await host.api.processingStatus(request)).items[0].kinds
  expect(states).toMatchObject([{ state: 'ready', system: 'probe.fallback' }, { state: 'empty' }, { state: 'skipped' }, { state: 'blocked', reason: expect.stringContaining('按需') }, { state: 'blocked' }])
  expect(lazyRuns).toBe(0)
  host.api.demand(id, 'probe.lazy'); await host.scheduler.idle()
  expect((await host.api.processingStatus(request)).items[0].kinds[3].state).toBe('ready')
  host.api.trash([id])
  expect((await host.api.processingStatus({ ...request, ids: [id, 'missing'] })).items.map(i => i.state)).toEqual(['trashed', 'missing'])
})

it('插件缺少外部程序时报告受阻，不误报队列完成；非法大批次拒绝', async () => {
  const host = setup([{ id: 'probe.work', has: ['text'], outputs: ['probe.out'], priority: 1, run: async () => ({}) }], ['probe.out'], { requires: { programs: ['rm-missing-processing-test-program'] } })
  const [id] = await host.api.ingest([{ type: 'text', text: '不可用加工' }])
  await host.scheduler.idle()
  expect((await host.api.processingStatus({ ids: [id], kinds: ['probe.out'] })).items[0].kinds[0]).toMatchObject({ state: 'blocked', reason: '找不到 rm-missing-processing-test-program' })
  expect(() => host.api.processingStatus({ ids: Array(101).fill(id), kinds: ['probe.out'] })).toThrow()
})
