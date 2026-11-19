import assert from 'node:assert/strict'
import { colorFamily, paletteFamilies, FAMILIES } from '../lib/color-families'
import { extractPalette } from '../lib/palette'
const fixtures: Record<string,string> = { '#ff0000':'红色','#ff8000':'橙色','#ffff00':'黄色','#00ff00':'绿色','#00ffff':'青色','#0000ff':'蓝色','#8000ff':'紫色','#ff00ff':'粉色','#805020':'棕色','#000000':'黑色','#808080':'灰色','#ffffff':'白色','#ffb6c1':'粉色' }
for (const [hex, expected] of Object.entries(fixtures)) assert.equal(colorFamily(hex),expected,hex)
for (const bad of [null,undefined,'red','#fff','#00000000','#GG0000',123]) assert.equal(colorFamily(bad),undefined)
assert.equal(colorFamily('#FF0000'),'红色')
assert.equal(colorFamily('#282828'),'黑色');assert.equal(colorFamily('#292929'),'灰色')
assert.equal(colorFamily('#e5e5e5'),'灰色');assert.equal(colorFamily('#e6e6e6'),'白色')
assert.deepEqual(paletteFamilies(['#ff0000','#dd1111','#0000ff','bad']),['红色','蓝色'])
assert.deepEqual(paletteFamilies(undefined),[])
for (const {name,color} of FAMILIES) assert.equal(colorFamily(color),name,`标准色块应与自身分类相符：${name}`)
// 真实提取结果也能分类，不以手填字段掩盖提取/归类间的偏差。
for (const [rgb, family] of [[[255,0,0],'红色'],[[0,0,255],'蓝色'],[[255,255,255],'白色']] as const) {
  const bytes=Uint8Array.from(Array.from({length:64},()=>[...rgb]).flat())
  assert.deepEqual(paletteFamilies(extractPalette(bytes).map(s=>s.hex)),[family])
}
console.log('色系：标准样本、黑白边界、去重、非法值与实际提取接续通过')
