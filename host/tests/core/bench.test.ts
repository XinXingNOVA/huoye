// 性能基准：npm run bench。默认跳过。
// 生成 10 万个素材（文件块 + 图片块 + 标签块，十分之一有笔记），测量常用查询、全文搜索的耗时。

import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { RegisteredSystem } from '../../src/core/registry'
import { openHost } from '../helpers/helpers'

const N = Number(process.env.BENCH_N ?? 100_000)
const NOTES = [
  '冷暖对比很漂亮，右下角的留白可以借鉴。主体放在三分线上，背景压暗。',
  '逆光拍的轮廓光，发丝边缘很干净，适合做海报主视觉。',
  'Grid system with generous whitespace; typography carries the hierarchy.',
  '夜景长曝光，车轨的线条把视线引到建筑上，色温偏冷。'
]
const TAGS = ['光影', '夜景', '人像', '建筑', '海报', '字体', '配色', '构图', '运镜', '质感', '插画', '摄影']

function time<T>(label: string, fn: () => T, results: string[]): T {
  const t0 = performance.now()
  const out = fn()
  const ms = performance.now() - t0
  results.push(`${label.padEnd(36)} ${ms.toFixed(1).padStart(8)} ms`)
  return out
}

describe.skipIf(!process.env.BENCH)('基准', () => {
  it(`${N} 个素材的查询耗时`, () => {
    const { host, cleanup } = openHost()
    host.scheduler.stop() // 只测查询，不跑加工
    const results: string[] = []
    const store = host.store

    time(
      `生成 ${N} 个素材（3 个数据块/个）`,
      () => {
        const chunk = 5000
        for (let start = 0; start < N; start += chunk) {
          store.batch(() => {
            for (let i = start; i < Math.min(N, start + chunk); i++) {
              const id = store.createEntity(1_700_000_000_000 + i * 1000)
              const w = 400 + ((i * 37) % 3600)
              const h = 400 + ((i * 53) % 3600)
              store.put(id, 'file', { name: `img_${i}.jpg`, ext: i % 5 === 0 ? 'png' : 'jpg', mime: 'image/jpeg', size: (i * 7919) % 20_000_000, hash: `h${i}`, path: `files/${id}/img_${i}.jpg` })
              store.put(id, 'image', { width: w, height: h, animated: false })
              store.put(id, 'tags', { values: [TAGS[i % TAGS.length], TAGS[(i * 7) % TAGS.length]] })
              if (i % 10 === 0) store.put(id, 'note', { text: `${NOTES[(i / 10) % NOTES.length]}（第 ${i} 张）` })
            }
          })
        }
      },
      results
    )

    const all = time('全部素材（ID + 宽高比，按时间倒序）', () => host.api.query({}), results) as { ids: string[]; aspects: number[] }
    expect(all.ids.length).toBe(N)
    expect(all.aspects.every((a) => a > 0)).toBe(true)

    time('按标签筛选', () => host.api.query({ where: [{ op: 'eq', kind: 'tags', field: 'values', value: '光影' }] }), results)
    time('两个标签同时满足', () =>
      host.api.query({
        where: [
          { op: 'eq', kind: 'tags', field: 'values', value: '光影' },
          { op: 'eq', kind: 'tags', field: 'values', value: '构图' }
        ]
      }), results)
    time('宽度 ≥ 3000 且格式为 png', () =>
      host.api.query({
        where: [
          { op: 'range', kind: 'image', field: 'width', min: 3000 },
          { op: 'eq', kind: 'file', field: 'ext', value: 'png' }
        ]
      }), results)
    time('按文件大小排序', () => host.api.query({ sort: { kind: 'file', field: 'size' } }), results)
    time('有图片块、没有笔记块', () => host.api.query({ has: ['image'], lacks: ['note'] }), results)
    time('标签分面统计', () => host.api.facet('tags', 'values'), results)
    time('读取 200 个身份的全部数据块', () => host.api.get(all.ids.slice(0, 200)), results)

    const leftWhite = time('全文：留白（1 万条笔记里 1/4 有）', () => host.api.query({ text: '留白' }), results) as { ids: string[] }
    expect(leftWhite.ids.length).toBe(N / 40)
    time('全文：两个词（轮廓 海报）', () => host.api.query({ text: '轮廓 海报' }), results)
    time('全文：西文前缀（typo）', () => host.api.query({ text: 'typo' }), results)
    time('全文：文件名（img_12345）', () => host.api.query({ text: 'img_12345' }), results)
    time('全文 + 标签筛选', () => host.api.query({ text: '留白', where: [{ op: 'eq', kind: 'tags', field: 'values', value: '光影' }] }), results)
    time('全文：常见的字（的）', () => host.api.query({ text: '的' }), results)
    time('命中的那一句 × 60', () => host.api.snippets(leftWhite.ids.slice(0, 60), '留白'), results)
    time('重建全文索引', () => store.search.rebuild(), results)

    const scheduler = host.scheduler as unknown as { findWork(s: RegisteredSystem): string[]; fullScan: Set<string> }
    const still = host.reg.systems.find((s) => s.id === 'image.still')!
    scheduler.fullScan.add(still.id)
    time('加工调度全量扫描（全部待处理）', () => scheduler.findWork(still), results)

    // 全部标记为已处理，测启动时"检查一遍、没有工作"的耗时
    host.lib.db.exec(`
      INSERT INTO derived.derivation (entity_id, system, input_key, plugin_ver, status, updated_at)
      SELECT b.entity_id, 'image.still', 'file:' || b.seq, ${still.pluginVersion}, 'ok', 0 FROM main.block b WHERE b.kind = 'file'`)
    scheduler.fullScan.add(still.id)
    const none = time('加工调度全量扫描（全部已是最新）', () => scheduler.findWork(still), results)
    expect(none).toEqual([])

    process.stdout.write(`\n${results.join("\n")}\n\n`)
    cleanup()
  }, 600_000)
})
