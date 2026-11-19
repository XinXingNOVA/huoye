import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { labels } from './report.mjs'
const [beforePath, afterPath] = process.argv.slice(2)
assert(beforePath && afterPath, '用法：node scripts/performance/compare.mjs baseline.json current.json')
const before = JSON.parse(readFileSync(beforePath, 'utf8')), after = JSON.parse(readFileSync(afterPath, 'utf8'))
assert(before.complete && after.complete, '报告尚未完整运行成功')
assert.equal(before.format, after.format, '报告格式不同')
assert.equal(before.harness, after.harness, '测量口径不同，不能直接比较')
const warnings = []
for (const key of ['platform', 'arch', 'cpu', 'logicalCpus', 'memoryGB', 'os']) if (before.environment[key] !== after.environment[key]) warnings.push('环境变化：' + key)
const cases = after.cases.flatMap(current => {
  const baseline = before.cases.find(c => c.count === current.count && c.spaces === current.spaces)
  return baseline ? [{ baseline, current }] : []
})
assert(cases.length, '没有相同规模和空间数的场景')
console.log('# 性能基线对比\n')
console.log(`基线 ${before.createdAt} → 当前 ${after.createdAt}。百分比为中位耗时变化，正数表示耗时增加。\n`)
for (const { baseline, current } of cases) {
  if (JSON.stringify(baseline.plugins) !== JSON.stringify(current.plugins)) warnings.push(`${current.count}/${current.spaces} 的插件版本变化`)
  if (JSON.stringify(baseline.enabledPlugins) !== JSON.stringify(current.enabledPlugins)) warnings.push(`${current.count}/${current.spaces} 的启用插件变化`)
  if (JSON.stringify(baseline.runtime) !== JSON.stringify(current.runtime)) warnings.push(`${current.count}/${current.spaces} 的 Electron/Chromium 变化`)
  console.log(`## ${current.count} 项 / ${current.spaces} 空间\n\n| 场景 | 基线 ms | 当前 ms | 变化 |\n| --- | ---: | ---: | ---: |`)
  for (const [name, value] of Object.entries(current.metrics)) {
    const old = baseline.metrics[name]?.duration, now = value.duration
    if (!old || !now || name === 'idle_1000ms') continue
    console.log(`| ${labels[name] ?? name} | ${old.median.toFixed(1)} | ${now.median.toFixed(1)} | ${old.median ? ((now.median / old.median - 1) * 100).toFixed(1) + '%' : '—'} |`)
  }
  console.log()
}
if (warnings.length) console.log('比较限制：' + [...new Set(warnings)].join('；') + '。\n')
console.log('少量样本和共享硬件负载会波动；本工具展示差异，不按百分比自动判定回归。请同时核对原始样本、响应性及正确性。')
