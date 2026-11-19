import { z } from 'zod'
import type { CorePlugin } from '../../src/core/plugin'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { afterEach, expect, it } from 'vitest'
import { openHost } from '../helpers/helpers'
import type { ReviewPage } from '../../src/shared/batch-review'

let fixture: ReturnType<typeof openHost>
afterEach(() => fixture?.cleanup())
function setup() {
  fixture = openHost()
  const { host } = fixture
  const tag = (id: string, requestId: string, add: string[], remove: string[] = []) =>
    host.api.executeOperation({ operation: 'update_tags', requestId, args: { ids: [id], add, remove } })
  const create = async (...requestIds: string[]) => await host.api.reviewBatch({ action: 'create', title: '灯光参考', requestIds }) as ReviewPage
  return { host, tag, create }
}

it('空块移除可以撤回，另一项写入和空操作不冒充后续修改；撤回中的失败保持整张待验收', async () => {
  const { host, create, tag } = setup()
  const [a, b] = await host.api.ingest([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  await host.api.put(a, 'tags', { values: ['原标签'] })
  await tag(a, 'remove-first', [], ['原标签'])
  await tag(b, 'second-image', ['重点'])
  await tag(b, 'no-op-second', ['重点'])
  const page = await create('remove-first', 'second-image', 'no-op-second')
  expect(page.batch).toMatchObject({ items: 2, preserved: 0, unchangedRequests: ['no-op-second'] })
  const batchId = page.batch.id
  host.lib.db.exec("CREATE TEMP TRIGGER fail_batch BEFORE DELETE ON main.block WHEN OLD.kind='tags' BEGIN SELECT RAISE(ABORT,'test rollback'); END")
  expect(() => host.api.reviewBatch({ action: 'withdraw', batchId })).toThrow('test rollback')
  expect((await host.api.reviewBatch({ action: 'get', batchId }) as ReviewPage).batch.state).toBe('pending')
  expect(host.store.blocksOf(a).tags).toBeUndefined()
  host.lib.db.exec('DROP TRIGGER temp.fail_batch')
  await host.api.reviewBatch({ action: 'withdraw', batchId })
  expect(host.store.blocksOf(a).tags.data.values).toEqual(['原标签']); expect(host.store.blocksOf(b).tags).toBeUndefined()
})

it('两个百项操作合成一张单，分页覆盖全部身份，重复写同一素材只展示净变化', async () => {
  const { host, create } = setup()
  const ids = await host.api.ingest(Array.from({ length: 200 }, (_, i) => ({ type: 'text', text: `参考 ${i}` })))
  const update = (requestId: string, targets: string[], add: string[], remove: string[] = []) =>
    host.api.executeOperation({ requestId, operation: 'update_tags', args: { ids: targets, add, remove } })
  await update('first-hundred', ids.slice(0, 100), ['初选'])
  await update('second-hundred', ids.slice(100), ['精选'])
  await update('refine-first-hundred', ids.slice(0, 100), ['精选'], ['初选'])
  const page = await create('refine-first-hundred', 'first-hundred', 'second-hundred')
  expect(page.batch).toMatchObject({ items: 200, changes: 200 })
  const seen = new Set<string>(), batchId = page.batch.id
  let offset: number | null = 0
  do {
    const p = await host.api.reviewBatch({ action: 'get', batchId, offset, limit: 50 }) as ReviewPage
    for (const item of p.items) { seen.add(item.id); expect(item.changes[0].member).toBe('精选') }
    offset = p.nextOffset
  } while (offset !== null)
  expect(seen).toEqual(new Set(ids))
  await host.api.reviewBatch({ action: 'withdraw', batchId })
  expect(ids.every(id => !host.store.blocksOf(id).tags)).toBe(true)
})

it('拒绝夹有人工写入的同一块，永久清除素材使已建单和不完整的源历史失效', async () => {
  const { host, tag, create } = setup()
  const [a, b] = await host.api.ingest([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  await tag(a, 'before-human', ['初选'])
  await host.api.patch(a, 'tags', { values: ['人工'] })
  await tag(a, 'after-human', ['精选'])
  await expect(create('before-human', 'after-human')).rejects.toThrow('REVIEW_INTERLEAVED')
  const batch = await create('after-human')
  await host.api.executeOperation({ operation: 'update_tags', requestId: 'before-purge', args: { ids: [a,b], add: ['待验收'] } })
  await host.api.trash([a]); await host.api.purge([a])
  expect(() => host.api.reviewBatch({ action: 'get', batchId: batch.batch.id })).toThrow('REVIEW_UNAVAILABLE')
  expect(host.lib.db.prepare('SELECT count(*) FROM main.review_delta').pluck().get()).toBe(0)
  await expect(create('before-purge')).rejects.toThrow('REVIEW_HISTORY_UNAVAILABLE')
})

it('人工重排并改回或写入重复成员时保留整个已接手的列表，建单前后判定一致', async () => {
  const { host, tag, create } = setup()
  for (const early of [true, false]) {
    const [id] = await host.api.ingest([{ type: 'text', text: '列表 ' + early }])
    await host.api.put(id, 'tags', { values: ['起点', '终点'] })
    const request = 'order-protection-' + early
    await tag(id, request, ['中转'])
    let batch = early ? await create(request) : undefined
    for (const values of [['中转','起点','终点'], ['起点','终点','中转'], ['起点','终点','中转','中转']])
      await host.api.put(id, 'tags', { values })
    batch ??= await create(request)
    const page = host.api.reviewBatch({ action: 'withdraw', batchId: batch.batch.id }) as ReviewPage
    expect(page.items[0].changes[0].preserved).toBe(true)
    expect(host.store.blocksOf(id).tags.data.values).toEqual(['起点','终点','中转','中转'])
  }
})

it('只保留可独立回放的命令；混入无历史写入、跨项重排或插件声明排除时，任务写入与回执一起回滚', async () => {
  const plugin: CorePlugin = {
    id: 'sample', version: 1, blocks: [
      { id: 'sample', plugin: 'sample', title: '样片', version: 1, rebuildable: false, fields: { rank: { type: 'number', title: '位置', index: true } } },
      { id: 'sample.local', plugin: 'sample', title: '进度', version: 1, rebuildable: false, history: false, fields: {} }
    ],
    commands: { edit(ctx, args) {
      const { id, action } = args as { id: string; action: string }
      if (action === 'sort') ctx.query({ sort: { kind: 'sample', field: 'rank' } })
      ctx.put(id, 'sample', { rank: 2 })
      if (action === 'mixed') ctx.put(id, 'sample.local', {})
      return { label: '编辑样片' }
    } },
    operations: ['sample_edit', 'sample_coupled'].map(name => ({
      name, title: '编辑', description: '修改样片', effect: 'data', command: 'edit',
      input: z.object({ id: z.string(), action: z.string() }), ...(name === 'sample_coupled' ? { reviewable: false as const } : {})
    }))
  }
  fixture = openHost([...legacyCorePlugins, plugin], { manifest: [...legacyManifest, { id: 'sample', title: '样片', description: '测试' }] })
  const { api } = fixture.host
  const [id] = await api.ingest([{ type: 'text', text: '样片' }])
  const taskId = 'sample-test-task'
  api.libraryTask({ action: 'create', taskId, title: '检查草稿', inputs: ['/input.png'] })
  for (const [action, operation] of [['mixed', 'sample_edit'], ['sort', 'sample_edit'], ['coupled', 'sample_coupled']]) {
    const input = { operation, requestId: 'request-' + action, args: { id, action } }
    expect(() => api.executeOperation({ ...input, taskId })).toThrow('REVIEW_UNSUPPORTED')
    expect(fixture.host.store.blocksOf(id).sample).toBeUndefined()
    expect(fixture.host.store.blocksOf(id)['sample.local']).toBeUndefined()
    expect((await api.executeOperation(input)).replayed).toBe(false)
    expect(() => api.reviewBatch({ action: 'create', title: '不能部分补单', requestIds: [input.requestId] })).toThrow('REVIEW_UNSUPPORTED')
    await api.remove(id, 'sample')
    if (action === 'mixed') await api.remove(id, 'sample.local')
  }
})

it('旧仓库的终态和未决单可升级；单项撤回重试不影响后来编辑，混入不属于单据的 ID 整批拒绝', async () => {
  const { host, tag, create } = setup()
  const { api } = host
  const [a,b] = await api.ingest([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  await tag(a,'legacy-done',['旧单'])
  const old = (await create('legacy-done')).batch.id
  await api.reviewBatch({ action: 'withdraw', batchId: old })
  await tag(a,'legacy-left',['候选']); await tag(b,'legacy-right',['候选'])
  const batchId = (await create('legacy-left','legacy-right')).batch.id
  // 复原上一发行版的列与差异形态。旧普通块只有字段记录，整批结论只在 review_sheet 中。
  host.lib.db.exec(`DELETE FROM main.review_delta WHERE position<0;
    DROP TRIGGER main.review_watch_v3_INSERT;
    DROP TRIGGER main.review_watch_v3_UPDATE;
    DROP TRIGGER main.review_watch_v3_DELETE;
    DROP TRIGGER main.review_drop_sheet_v2;
    DROP TABLE main.review_withdrawn;
    ALTER TABLE main.review_delta DROP COLUMN kind_version;`)
  const root = fixture.root
  host.close()
  fixture = openHost(undefined, undefined, root)
  const next = fixture.host.api
  expect(next.reviewBatch({ action: 'get', batchId: old })).toMatchObject({ batch: { withdrawnItems: 1 }, items: [{ withdrawn: true }] })
  expect(() => next.reviewBatch({ action: 'withdraw', batchId, ids: [a, 'missing'] })).toThrow('INVALID_INPUT')
  expect(next.reviewBatch({ action: 'withdraw', batchId, ids: [a, a] })).toMatchObject({ batch: { state: 'pending', withdrawnItems: 1 } })
  expect(fixture.host.store.blocksOf(a).tags).toBeUndefined()
  await next.put(a, 'tags', { values: ['人工'] })
  next.reviewBatch({ action: 'withdraw', batchId, ids: [a] })
  expect(fixture.host.store.blocksOf(a).tags.data.values).toEqual(['人工'])
  expect(next.reviewBatch({ action: 'withdraw', batchId, ids: [b] })).toMatchObject({ batch: { state: 'withdrawn', withdrawnItems: 2 } })
})
