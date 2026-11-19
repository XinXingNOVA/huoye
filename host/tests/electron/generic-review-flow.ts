import assert from 'node:assert/strict'
import type { ReviewPage } from '../../src/shared/batch-review'
import type { LibraryTaskResult } from '../../src/shared/library-task'

type Call = (name: string, args: Record<string, unknown>) => Promise<any>
const sample = 'review-sample.card'

export async function prepareGenericReview(libraryId: string, taskId: string, ids: string[], call: Call) {
  const op = (operation: string, requestId: string, args: object, draft = true) =>
    call('execute_operation', { libraryId, operation, requestId, args, ...(draft ? { taskId } : {}) })
  const group = (await op('collection_create', 'sample-folder', { title: '参考目录' }, false)).result.id
  const { template, kind: fieldKind } = (await op('fields_create_template', 'sample-template', { title: '用稿' }, false)).result as { template: string; kind: string }
  const field = (await op('fields_add_field', 'sample-add-field', { template, title: '版面', type: 'text' }, false)).result.field
  await op('sample_edit', 'sample-custom', { ids, themes: ['建筑'], related: group })
  await op('set_note', 'sample-note', { id: ids[0], text: '第一稿' })
  await op('collection_move', 'sample-group', { ids, group })
  await op('fields_set_values', 'sample-fill', { template, items: ids.map(id => ({ id, expectedSeq: 0, values: { [field]: '封面' } })) })
  await op('update_tags', 'sample-tags', { ids, add: ['候选'] }, false)
  await op('set_rating', 'sample-ratings', { ids, value: 5 }, false)
  const { batch } = await call('review_batch', { libraryId, action: 'create', title: '标签与评分', requestIds: ['sample-tags', 'sample-ratings'] })
  const part = await call('review_batch', { libraryId, batchId: batch.id, action: 'withdraw', ids: [ids[0]] })
  assert.equal(part.batch.state, 'pending')
  assert.equal(part.batch.withdrawnItems, 1)
  return { libraryId, taskId, ids, group, fieldKind, partial: batch.id }
}

export async function resumeGenericReview(state: Awaited<ReturnType<typeof prepareGenericReview>>, call: Call,
  withdrawInWorkbench: (batchId: string, id: string) => Promise<void>) {
  const { libraryId, taskId, ids: [a, b], partial, group, fieldKind } = state
  const requestIds = ['sample-custom', 'sample-note', 'sample-group', 'sample-fill']
  const review = (input: object): Promise<ReviewPage> => call('review_batch', { libraryId, ...input })
  const task = (input: object): Promise<Extract<LibraryTaskResult, { task: unknown }>> => call('library_task', { libraryId, taskId, ...input })
  const item = async (id: string, kinds: string[]) => (await call('read_item', { libraryId, id, kinds })).fields
  const old = await review({ batchId: partial, action: 'get' })
  assert.equal(old.items.find(i => i.id === a)?.withdrawn, true)
  await review({ batchId: partial, action: 'confirm' })
  assert.equal((await item(a, ['tags','rating'])).length, 0)
  assert((await item(b, ['rating'])).some((f: any) => f.preview === 5))
  assert.deepEqual(new Set((await task({ action: 'get', section: 'writes' })).writes?.map(w => w.requestId)), new Set(requestIds))
  const draft = await task({ action: 'diff', requestId: 'sample-custom' })
  assert(draft.draft?.items.every(i => i.changes.some(c => c.field === 'related' && c.referenceTitles?.[group] === '参考目录')))
  const { batch } = await review({ action: 'create', title: '补交样片与归档', requestIds })
  assert.equal(batch.items, 2)
  const op = (operation: string, requestId: string, args: object) => call('execute_operation', { libraryId, operation, requestId, args })
  await op('set_note', 'later-edit-note', { id: a, text: '校对稿' })
  await op('set_note', 'later-edit-back', { id: a, text: '第一稿' })
  await op('sample_edit', 'later-add-theme', { ids: [a], themes: ['建筑','人工补充'], related: group })
  const select = { batchId: batch.id, action: 'withdraw', ids: [a] }
  await withdrawInWorkbench(batch.id, a)
  const part = await review({ batchId: batch.id, action: 'get' })
  assert.equal(part.items.find(i => i.id === a)?.withdrawnBy, 'application')
  assert.equal(part.batch.withdrawnItems, 1)
  assert(part.items.find(i => i.id === a)?.changes.some(c => c.kind === 'note' && c.preserved))
  assert.equal((await review(select)).batch.withdrawnItems, 1)
  assert.deepEqual((await item(a, [sample])).map((f: any) => f.preview), [['人工补充']])
  assert.equal((await item(a, ['collectionMember', fieldKind])).length, 0)
  assert((await item(b, [fieldKind])).some((f: any) => f.preview === '封面'))
  assert.equal((await item(a, ['note']))[0].preview, '第一稿')
  assert((await item(b, [sample])).some((f: any) => f.preview === group))
  assert((await item(b, ['collectionMember'])).some((f: any) => f.preview === group))
  assert.equal((await review({ action: 'confirm', batchId: batch.id })).batch.state, 'confirmed')
}
