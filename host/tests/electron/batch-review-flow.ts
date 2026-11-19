import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callCore } from '../../src/main/core-client'
import type { OpenLibrary } from '../../src/main/libraries'
import type { ReviewPage } from '../../src/shared/batch-review'

export async function checkReview(lib: OpenLibrary, ids: string[], template: { template: string; kind: string }, dir: string,
  call: (name: string, args: Record<string, unknown>) => Promise<any>,
  denied: (name: string, args: Record<string, unknown>, code: string) => Promise<void>,
  mode: (value: string) => Promise<unknown>, until: (fn: () => unknown | Promise<unknown>, label: string) => Promise<void>) {
  const libraryId = lib.id, win = lib.win
  const op = (operation: string, requestId: string, args: Record<string, unknown>) => call('execute_operation', { libraryId, operation, requestId, args })
  const review = (args: Record<string, unknown>): Promise<ReviewPage> => call('review_batch', { libraryId, ...args })
  const values = () => callCore(lib.core, 'get', ids)
  const field = (await op('fields_add_field', 'review-test-field', { template: template.template, title: '画面用途', type: 'text' })).result.field
  const requests = ['review-two-tags', 'review-two-ratings', 'review-two-values']
  await op('update_tags', requests[0], { ids, add: ['待发布','封面'], remove: ['灵感'] })
  await op('set_rating', requests[1], { ids, value: 4 })
  const prior = await values()
  await op('fields_set_values', requests[2], { template: template.template, items: ids.map(id => ({
    id, expectedSeq: prior.find(v => v.id === id)?.blocks[template.kind]?.seq ?? 0, values: { [field]: '投放' }
  })) })
  await op('set_rating', 'review-rating-unchanged', { ids, value: 4 })
  requests.push('review-rating-unchanged')
  const create = { action: 'create', title: '视觉素材 · 投放精选', requestIds: requests }
  await denied('review_batch', { libraryId, ...create, requestIds: [...requests, 'review-test-field'] }, 'REVIEW_UNSUPPORTED')
  const plan = await review(create), batchId = plan.batch.id
  assert.equal(plan.batch.items, 2); assert.deepEqual(plan.batch.unchangedRequests, ['review-rating-unchanged'])
  assert.equal((await review({ ...create, requestIds: [...requests].reverse() })).batch.id, batchId)
  const first = await review({ action: 'get', batchId, limit: 1 })
  assert.equal(first.nextOffset, 1)
  assert.notEqual(first.items[0].id, (await review({ action: 'get', batchId, offset: 1 })).items[0].id)
  assert(plan.items.every(i => i.changes.some(c => c.field === field && c.before === null && c.after === '投放')))
  const [left,right] = ids
  // 与检查器相同的本地写入：手改后改回原星级、只修正一个标签、同模板保留人填的值。
  await callCore(lib.core, 'patch', right, 'rating', { value: 3 }); await callCore(lib.core, 'patch', right, 'rating', { value: 4 })
  await callCore(lib.core, 'run', 'tags', 'update', { ids: [right], add: ['手工标签'], remove: ['封面'] })
  await callCore(lib.core, 'patch', right, template.kind, { [field]: '人工校色' })
  await mode('read')
  assert.equal((await review({ action: 'get', batchId })).batch.state, 'pending')
  await denied('review_batch', { libraryId, action: 'withdraw', batchId }, 'READ_ONLY')
  await denied('review_batch', { libraryId, ...create }, 'READ_ONLY')
  await mode('organize')
  const expected = (await call('get_workbench_session', { libraryId })).expected
  const presented = await call('present_workbench', { libraryId, expected, target: { action: 'open_review', batchId }, requestId: 'present-visual-review' })
  const selector = `[data-tab-content="${presented.tabId}"] .batch-review`
  await until(() => win.webContents.executeJavaScript(`document.querySelectorAll('${selector} [data-review-item]').length===2`), '验收页素材')
  assert((await win.webContents.executeJavaScript(`document.querySelector('${selector}').innerText`)).includes('画面用途'))
  const reopened = await call('present_workbench', { libraryId, expected: (await call('get_workbench_session', { libraryId })).expected,
    target: { action: 'open_review', batchId }, requestId: 'reshow-visual-review' })
  assert.equal(reopened.tabId, presented.tabId, '重复展示复用同一张验收页')
  writeFileSync(join(dir, 'batch-review.png'), (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('${selector} button')].find(b=>b.textContent==='整批撤回').click()`)
  await until(async () => (await review({ action: 'get', batchId })).batch.state === 'withdrawn', '人从验收单撤回')
  const done = await review({ action: 'withdraw', batchId })
  assert.equal(done.batch.decidedBy, 'application'); assert(done.batch.preserved >= 3)
  await denied('review_batch', { libraryId, batchId, action: 'confirm' }, 'REVIEW_DECIDED')
  const final = await values(), a = final.find(v => v.id === left)!, b = final.find(v => v.id === right)!
  assert.deepEqual(a.blocks.tags.data.values, ['灵感']); assert.equal(a.blocks.rating.data.value, 5)
  assert.equal(a.blocks[template.kind].data[field], undefined)
  assert.deepEqual(new Set(b.blocks.tags.data.values as string[]), new Set(['灵感','手工标签']))
  assert.equal(b.blocks.rating.data.value, 4); assert.equal(b.blocks[template.kind].data[field], '人工校色')
  await op('update_tags', 'review-after-restart', { ids: [right], add: ['下次验收'] })
  const pending = await review({ action: 'create', title: '重开后验收', requestIds: ['review-after-restart'] })
  await op('update_tags', 'review-rollback-restart', { ids: [right], add: ['重开待撤', '重开修正'] })
  const rollback = await review({ action: 'create', title: '重开后撤回', requestIds: ['review-rollback-restart'] })
  await callCore(lib.core, 'run', 'tags', 'update', { ids: [right], add: [], remove: ['重开修正'] })
  await callCore(lib.core, 'run', 'tags', 'update', { ids: [right], add: ['重开修正'], remove: [] })
  await mode('admin')
  return { withdrawn: batchId, pending: pending.batch.id, rollback: rollback.batch.id, right }
}
