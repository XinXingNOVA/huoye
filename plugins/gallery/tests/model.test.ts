import { test } from 'node:test'
import assert from 'node:assert/strict'
import { locate, readOptions, windowRange } from '../model.ts'

test('reordering preserves the browsed identity, removal chooses the nearest remaining position', () => {
  assert.deepEqual(locate(['c', 'a', 'b'], 'b', 1), { id: 'b', index: 2 })
  assert.deepEqual(locate(['c', 'a'], 'b', 1), { id: 'a', index: 1 })
  assert.deepEqual(locate(['c'], 'b', 100), { id: 'c', index: 0 })
  assert.deepEqual(locate([], 'b', 1), { id: undefined, index: -1 })
  assert.deepEqual(locate(['a'], undefined, NaN), { id: 'a', index: 0 })
})
test('filmstrip virtualization stays bounded for large result sets', () => {
  const { first, last } = windowRange(100000, 500000, 600, 100)
  assert.equal(first, 4997); assert.equal(last, 5009)
  assert.deepEqual(windowRange(2, 0, 600, 100), { first: 0, last: 2 })
})
test('options accept only supported presentation modes', () => {
  assert.deepEqual(readOptions({ fit: 'fill', strip: null }), { fit: 'contain', strip: 'bottom' })
  assert.deepEqual(readOptions({ fit: 'cover', strip: 'right' }), { fit: 'cover', strip: 'right' })
})
