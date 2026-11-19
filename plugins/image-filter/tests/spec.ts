import assert from 'node:assert/strict'
import { geometry, parseRange } from '../model'
for (const [w,h,shape] of [[100,100,'方图'],[299,100,'横图'],[300,100,'长横图'],[100,299,'竖图'],[100,300,'长竖图']] as const) assert.equal(geometry(w,h)?.shape,shape)
for (const n of [0,-1,NaN,Infinity,'100',undefined]) assert.equal(geometry(n,100),null)
assert.deepEqual(geometry(100,300),{shape:'长竖图',ratio:1/3,longSide:300,shortSide:100})
assert.deepEqual(parseRange('','1080'),{max:1080})
assert.deepEqual(parseRange('1080',''),{min:1080})
assert.deepEqual(parseRange('',''),{})
for (const [a,b] of [['0',''],['1.5',''],['2','1'],['NaN',''],['','Infinity']]) assert.throws(() => parseRange(a,b))
console.log('画幅：分类边界、无效尺寸和范围校验通过')
