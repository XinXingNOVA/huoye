import assert from 'node:assert/strict'
import { setRating } from '../core'
import { blocks } from '../blocks'
for (const value of [0,6,2.5]) assert.throws(() => blocks[0].validate!({value}))
blocks[0].validate!({})
const rows = new Map<string, any>([['a', {}], ['b', {}]])
const ctx: any = { query: ({ids}: any) => ({ids: ids.filter((id: string) => rows.has(id))}), blocksOf: (id: string) => rows.get(id), put: (id: string, kind: string, data: any) => { rows.get(id)[kind] = {data} }, remove: (id: string, kind: string) => {delete rows.get(id)[kind]} }
for (const value of [0, 6, 2.5, '3']) assert.throws(() => setRating(ctx, {ids:['a'], value}))
assert.throws(() => setRating(ctx, {ids:[], value:4}))
assert.throws(() => setRating(ctx, {ids:Array(101).fill('a'), value:4}))
assert.throws(() => setRating(ctx, {ids:['a', 'missing'], value:4}))
assert.equal(rows.get('a').rating, undefined, '先校验整批，不可部分写入')
assert.deepEqual(setRating(ctx, {ids:['a','a','b'], value:4}).result.ids, ['a','b'])
assert.equal(rows.get('b').rating.data.value,4)
setRating(ctx, {ids:['a'], value:null})
assert.equal(rows.get('a').rating,undefined)
assert.equal(rows.get('b').rating.data.value,4)
console.log('评分：边界校验、整批拒绝、去重和清除通过')
