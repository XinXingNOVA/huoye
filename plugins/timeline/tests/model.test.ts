import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arrange, groupItems, readOptions, rowAt } from '../model.ts'

test('local calendar grouping, stable ties, unknown dates stay last in both directions', () => {
  const jan = new Date(2026, 0, 31, 23, 59).getTime(), feb = new Date(2026, 1, 1, 0, 1).getTime()
  const dates = new Map([['a', jan], ['b', feb], ['c', feb], ['bad', NaN]])
  const ids = ['a', 'c', 'b', 'bad', 'missing']
  const groups = groupItems(ids, dates, 'month', false)
  assert.deepEqual(groups.map(g => g.ids), [['c', 'b'], ['a'], ['bad', 'missing']])
  assert.deepEqual(groupItems(ids, dates, 'month', true).map(g => g.ids), [['a'], ['c', 'b'], ['bad', 'missing']])
  assert.equal(groupItems(ids, dates, 'year', false).length, 2)
  assert.equal(groups[0].label, '2026年2月')
  assert.deepEqual(ids, ['a', 'c', 'b', 'bad', 'missing'])
})
test('folded groups retain identities and navigation order; viewport covers edges in a narrow pane', () => {
  const groups = [{ key: 'a', label: 'A', ids: ['1', '2', '3'] }, { key: 'b', label: 'B', ids: ['4'] }]
  const narrow = arrange(groups, new Set(['a']), 100, 180)
  assert.deepEqual(narrow.rows.flatMap(r => r.ids), ['4'])
  assert.equal(narrow.positions.get('3'), 4)
  assert.equal(rowAt(narrow.rows, 0), 0)
  assert.equal(rowAt(narrow.rows, narrow.height), narrow.rows.length - 1)
  const wide = arrange(groups, new Set(), 800, 180)
  assert.deepEqual(wide.rows.flatMap(r => r.ids), ['1', '2', '3', '4'])
  assert(wide.cardWidth > 0)
})
test('invalid and older options fall back without breaking a saved view', () => {
  assert.deepEqual(readOptions({ group: 'week', ascending: 'true' }), { group: 'month', ascending: false })
})
