import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { anchorBlock, type PdfFragment } from '../fixtures/legacy-annotate/blocks'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import { readingPosition } from '../../src/plugins/pdf/blocks'
import { normalizePdfText } from '../../src/plugins/pdf/text'
import type { ExportResult } from '../../src/shared/rpc'
import { openHost, tempDir } from '../helpers/helpers'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })
function setup(root?: string) { const h = openHost(undefined, undefined, root); cleanup = h.cleanup; return h }
function reopen(h: ReturnType<typeof setup>) { h.host.close(); return setup(h.root) }
const ids = (r: unknown) => (r as { ids: string[] }).ids
const fragments: PdfFragment[] = [
  { page: 2, quote: '留白', rects: [{ x: .1, y: .8, w: .3, h: .04 }] },
  { page: 3, quote: '节奏', rects: [{ x: .1, y: .1, w: .3, h: .04 }] }
]
const anchor = (target: string) => ({ target, type: 'PDF摘录', sourceHash: 'original', page: 2, quote: '留白\n\n节奏', fragments, aspect: 1.4 })

// 使用原始块验证持久化/依附关系；真实 PDF 加工由 pdf.test 和 Electron 新文件导入覆盖。
async function library() {
  const h = setup()
  const id = h.host.store.createEntity()
  h.host.store.put(id, 'file', { name: 'book.bin', path: 'book.bin', ext: 'bin', hash: 'original', size: 0 })
  h.host.store.put(id, 'pdf', { pages: 3, width: 612, height: 792 })
  await h.host.scheduler.idle()
  return { ...h, id }
}

describe('PDF 阅读进度', () => {
  it('恢复位置限制在有效页与页内范围', () => {
    expect(readingPosition(undefined, 3)).toEqual({ page: 1, offset: 0 })
    expect(readingPosition({ page: 9, offset: 2 }, 3)).toEqual({ page: 3, offset: 1 })
    expect(readingPosition({ page: 2.9, offset: -.4 }, 3)).toEqual({ page: 2, offset: 0 })
    expect(readingPosition({ page: NaN, offset: Infinity }, 0)).toEqual({ page: 1, offset: 0 })
  })
  it('重开后续读；进度不占撤销历史、不改变 PDF 的内容', async () => {
    const a = await library()
    const before = a.host.store.blocksOf(a.id).file
    a.host.api.put(a.id, 'note', { text: '笔记' })
    a.host.api.run('pdf', 'saveReading', { id: a.id, hash: 'original', page: 2, offset: .43, lastRead: 10 })
    // 后到的旧进度／旧文件版本不能覆盖；同时间回调重试不产生新写入。
    const seq = a.host.store.blocksOf(a.id).pdfreading.seq
    for (const patch of [{ lastRead: 9 }, { lastRead: 10 }, { hash: 'old', lastRead: 20 }]) a.host.api.run('pdf', 'saveReading', { id: a.id, hash: 'original', page: 1, offset: 0, ...patch })
    expect(a.host.store.blocksOf(a.id).pdfreading.seq).toBe(seq)
    a.host.api.trash([a.id])
    a.host.api.run('pdf', 'saveReading', { id: a.id, hash: 'original', page: 1, offset: 0, lastRead: 30 })
    expect(a.host.store.blocksOf(a.id).pdfreading.seq).toBe(seq)
    a.host.api.undo()
    expect(a.host.api.undo()).toBe('修改笔记')
    expect(a.host.store.blocksOf(a.id).pdfreading.data.offset).toBe(.43)
    expect(a.host.store.blocksOf(a.id).file).toEqual(before)
    const b = reopen(a)
    expect(b.host.store.blocksOf(a.id).pdfreading.data).toEqual({ page: 2, offset: .43, lastRead: 10 })
    expect(() => b.host.api.put(a.id, 'pdfreading', { page: 1.5, offset: 0 })).toThrow()
  })
})

describe('PDF 摘录', () => {
  it('跨页摘录独立可搜、可加标签；删除原件时跟随，撤销后恢复', async () => {
    const { host, id } = await library()
    const local = host.api.create({ anchor: anchor(id), note: { text: '构图参考' }, tags: { values: ['学习'] } }) as string
    await host.scheduler.idle()
    expect(host.store.blocksOf(local).place.data.found).toBe(true)
    expect(ids(host.api.query({ text: '留白' }))).toEqual([local])
    expect(ids(host.api.query({ where: [{ op: 'eq', kind: 'tags', field: 'values', value: '学习' }] }))).toEqual([local])
    host.api.trash([id])
    expect(host.store.isTrashed(local)).toBe(true)
    host.api.undo()
    expect(host.store.isTrashed(local)).toBe(false)
    expect(host.store.blocksOf(local).anchor.data.fragments).toEqual(fragments)
  })
  it('文件改名仍有效，内容变化标记失配并保留摘录；恢复文件后重新有效', async () => {
    const { host, id } = await library()
    const local = host.api.create({ anchor: anchor(id) }) as string
    await host.scheduler.idle()
    const file = host.store.blocksOf(id).file.data
    host.store.put(id, 'file', { ...file, name: 'renamed.bin' })
    await host.scheduler.idle()
    expect(host.store.blocksOf(local).place.data.found).toBe(true)
    host.store.put(id, 'file', { ...file, hash: 'replaced' })
    await host.scheduler.idle()
    expect(host.store.blocksOf(local).place.data.found).toBe(false)
    expect(host.store.blocksOf(local).anchor.data.quote).toBe('留白\n\n节奏')
    host.store.put(id, 'file', file)
    await host.scheduler.idle()
    expect(host.store.blocksOf(local).place.data.found).toBe(true)
  })
  it('插件停用和启用后保留进度与摘录', async () => {
    const a = await library()
    const local = a.host.api.create({ anchor: anchor(a.id) }) as string
    a.host.api.put(a.id, 'pdfreading', { page: 3, offset: .1, lastRead: 20 })
    await a.host.scheduler.idle()
    a.host.api.setPlugins(['pdf', 'annotate'])
    const b = reopen(a)
    expect(b.host.store.blocksOf(local).anchor.data).toEqual(anchor(a.id))
    expect(b.host.store.blocksOf(a.id).pdfreading.data.page).toBe(3)
    expect(ids(b.host.api.query({ text: '留白' }))).toEqual([local])
    b.host.api.setPlugins([])
    const c = reopen(b)
    await c.host.scheduler.idle()
    expect(c.host.store.blocksOf(local).place.data.found).toBe(true)
  })
  it('拒绝无来源、乱序页码和越界坐标', () => {
    for (const data of [
      { ...anchor('source'), sourceHash: '' },
      { ...anchor('source'), fragments: [] },
      { ...anchor('source'), page: 1 },
      { ...anchor('source'), fragments: [fragments[1], fragments[0]] },
      { ...anchor('source'), fragments: [{ ...fragments[0], rects: [{ x: .9, y: 0, w: .2, h: .1 }] }] }
    ]) expect(() => anchorBlock.validate!(data)).toThrow()
    expect(normalizePdfText('留⽩，第⼆⻚')).toBe('留白，第二页')
  })
  it('旧版文本锚点迁移保留原文、定位和依附关系', async () => {
    const legacy = corePlugins.map((p) => p.id === 'annotate' ? { ...p, blocks: p.blocks?.map((b) => b.id === 'anchor' ? { ...b, version: 1 } : b) } : p)
    const a = openHost(legacy); cleanup = a.cleanup
    const [source] = await a.host.api.ingest([{ type: 'text', text: '旧的摘录' }])
    const data = { target: source, type: '文本区间', quote: '旧的', prefix: '', suffix: '', offset: 0, aspect: 2 }
    const local = a.host.api.create({ anchor: data }) as string
    await a.host.scheduler.idle()
    const b = reopen(a)
    expect(b.host.store.blocksOf(local).anchor.data).toEqual(data)
    b.host.api.trash([source])
    expect(b.host.store.isTrashed(local)).toBe(true)
  })
  it('导出索引保留摘录文字和页码', async () => {
    const { host, id } = await library()
    const local = host.api.create({ anchor: anchor(id), note: { text: '值得重读' } }) as string
    const parent = tempDir('rm-pdf-export-')
    const result = await host.api.exportRun({ ids: [local], titles: {}, parent, name: '摘录' }) as ExportResult
    const index = readFileSync(join(result.dir, '索引.md'), 'utf8')
    expect(index).toContain('留白')
    expect(index).toContain('PDF 第 2、3 页')
    expect(index).toContain('值得重读')
  })
})
