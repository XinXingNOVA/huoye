import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FacetPage, ItemDetails, ReadItemsResult, SearchPageResult } from '../../src/shared/automation'

export async function checkInventory(dir: string, libraryId: string,
  call: (name: string, args: Record<string, unknown>) => Promise<any>,
  denied: (name: string, args: Record<string, unknown>, code: string) => Promise<void>,
  setMode: (mode: string) => Promise<unknown>, until: (fn: () => Promise<boolean>, label: string) => Promise<void>) {
  const folder = join(dir, 'input')
  mkdirSync(folder)
  const records = Array.from({ length: 1200 }, (_, n) => {
    const ext = n % 2 ? 'md' : 'txt', path = join(folder, `参考-${n}.${ext}`)
    writeFileSync(path, `设计资料 ${n}\n`)
    const tags = n % 4 ? [`专题 ${n % 7}`, ...(n % 3 === 0 ? ['已复核'] : [])] : []
    return { path, ext, tags, id: '' }
  })
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100)
    const imported = await call('import_to_library', { libraryId, requestId: 'inventory-import-' + i,
      files: batch.map(({ path, tags }) => ({ path, ...(tags.length ? { metadata: { 'tags.add': { add: tags } } } : {}) })) })
    assert.deepEqual(imported.errors, [])
    assert.equal(imported.items.length, batch.length)
    for (const item of imported.items) batch[item.index].id = item.id
  }
  const seeded = records.map(r => r.id)
  assert(!seeded.includes('') && new Set(seeded).size === records.length)
  for (const [start, value] of [[0,5],[100,4]]) {
    await call('execute_operation', { libraryId, requestId: 'inventory-stars-' + start, operation: 'set_rating', args: { ids: seeded.slice(start, start + 100), value } })
  }
  await setMode('read')
  await until(async () => {
    const { processing: p } = await call('get_library_status', { libraryId, sections: ['processing'] })
    return !p.running && !p.queued && !p.pendingChecks && !p.scanningSystems
  }, '盘点前加工完成')
  const description = await call('describe_library', { libraryId })
  assert(description.kinds.some((k: { id: string }) => k.id === 'tags'))
  const ids: string[] = []
  let searchCursor: string | null = null, searchPages = 0
  do {
    const page: SearchPageResult = await call('search_items', { libraryId, query: { role: 'material' }, limit: 50,
      ...(searchCursor && { cursor: searchCursor }) })
    ids.push(...page.items.map(i => i.id))
    searchCursor = page.nextCursor
    searchPages++
  } while (searchCursor)
  assert.equal(ids.length, records.length)
  assert.deepEqual(new Set(ids), new Set(seeded))
  const facet = (input: object): Promise<FacetPage> => call('facet', { libraryId, ...input })
  const ratings = await facet({ kind: 'rating', field: 'value', query: { role: 'material' } })
  assert.deepEqual([ratings.matchedItems, ratings.withValue, ratings.missingItems], [1200, 200, 1000])
  assert.deepEqual(ratings.values, [{ value: 4, count: 100 }, { value: 5, count: 100 }])
  const expected = new Map<string, number>()
  for (const r of records.filter(r => r.ext === 'md')) for (const t of r.tags) expected.set(t, (expected.get(t) ?? 0) + 1)
  let cursor: string | null = null, facetPages = 0
  const actual = new Map<string, number>()
  do {
    const page = await facet({ kind: 'tags', field: 'values', query: { where: [{ kind: 'file', field: 'ext', op: 'eq', value: 'md' }] },
      limit: 3, ...(cursor && { cursor }) })
    assert.deepEqual([page.matchedItems, page.withValue, page.missingItems], [600,600,0])
    for (const row of page.values) { assert(typeof row.value === 'string' && !actual.has(row.value)); actual.set(row.value, row.count) }
    cursor = page.nextCursor
    facetPages++
  } while (cursor)
  assert.deepEqual(actual, expected)

  const kinds = ['tags','rating']
  const single: unknown[] = []
  const start = performance.now()
  for (const id of ids) {
    const result: ItemDetails = await call('read_item', { libraryId, id, kinds })
    single.push(result.fields.map(f => [f.kind, f.field, f.preview, f.seq]))
  }
  const singleMs = Math.round(performance.now() - start)
  const batched: unknown[] = []
  let batchCalls = 0
  const batchStart = performance.now()
  for (let i = 0; i < ids.length; i += 1000) {
    const input = ids.slice(i, i + 1000)
    let offset: number | null = 0
    do {
      const page: ReadItemsResult = await call('read_items', { libraryId, ids: input, kinds, offset })
      assert(page.items.length > 0)
      for (const item of page.items) {
        assert.equal(item.id, ids[batched.length])
        assert(item.state === 'active')
        const fields = Object.entries(item.blocks).sort(([a], [b]) => a.localeCompare(b)).flatMap(([kind, block]) => {
          assert(kinds.includes(kind) && 'data' in block)
          return Object.entries(block.data).map(([key, value]) => [kind, key, value, block.seq])
        })
        batched.push(fields)
      }
      batchCalls++
      offset = page.nextOffset
    } while (offset !== null)
  }
  const batchMs = Math.round(performance.now() - batchStart)
  assert.deepEqual(batched, single)
  assert.equal(batchCalls, 2)
  await setMode('off')
  await denied('facet', { libraryId, kind: 'file', field: 'ext' }, 'ACCESS_DENIED')
  await denied('read_items', { libraryId, ids: [ids[0]], kinds }, 'ACCESS_DENIED')
  return { items: ids.length, searchPages, withRating: ratings.withValue, missingRating: ratings.missingItems, filteredItems: 600,
    tagBuckets: actual.size, facetPages, singleCalls: single.length, singleMs, batchCalls, batchMs, readOnlyAndRevoked: true }
}
