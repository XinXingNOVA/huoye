// 局部批注（设计文档 4.5、11.2）：局部是一个身份，锚点块依附引用原素材；
// 批注插件裁出局部的代表图，缩略图由预览插件接上；原素材进回收站，局部跟着。

import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { parseAnnotation } from '../fixtures/legacy-annotate/parse'
import { openHost, tempDir } from '../helpers/helpers'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function setup() {
  const h = openHost()
  cleanup = h.cleanup
  return h
}

const ids = (r: unknown) => (r as { ids: string[] }).ids
const ofTarget = (id: string) => ({ where: [{ op: 'eq' as const, kind: 'anchor', field: 'target', value: id }] })

/** 一张 400×300 的图：左半红、右半蓝。 */
async function picture(h: ReturnType<typeof setup>) {
  const path = join(tempDir(), '照片.png')
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#0000ff' } })
    .composite([{ input: { create: { width: 200, height: 300, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])
    .png()
    .toFile(path)
  const [id] = await h.host.api.ingest([{ type: 'file', path }])
  await h.host.scheduler.idle()
  return id
}

const region = (target: string, x: number, y: number, w: number, h: number) => ({
  anchor: { target, type: '图片区域', x, y, w, h, aspect: (w * 400) / (h * 300) },
  note: { text: '反光处理很好' },
  tags: { values: ['光影'] }
})

describe('局部是一个身份', () => {
  it('圈一块：新建身份，挂锚点、笔记、标签；按原素材查出它的局部；局部也是素材', async () => {
    const h = setup()
    const img = await picture(h)
    const local = h.host.api.create(region(img, 0, 0, 0.25, 0.5)) as string
    expect(ids(h.host.api.query(ofTarget(img)))).toEqual([local])
    expect(ids(h.host.api.query({})).sort()).toEqual([img, local].sort())
    expect(ids(h.host.api.query({ where: [{ op: 'eq', kind: 'tags', field: 'values', value: '光影' }] }))).toEqual([local])
  })

  it('裁出局部的代表图，预览插件接着做缩略图和色板', async () => {
    const h = setup()
    const img = await picture(h)
    // 左上 1/4 宽：全是红色
    const local = h.host.api.create(region(img, 0, 0, 0.25, 0.5)) as string
    await h.host.scheduler.idle()
    const blocks = h.host.store.blocksOf(local)
    expect(String(blocks.still.data.path)).toBe(join('cache', 'locals', `${local}.jpg`))
    const meta = await sharp(join(h.root, String(blocks.still.data.path))).metadata()
    expect([meta.width, meta.height]).toEqual([100, 150])
    expect(blocks.thumb).toBeDefined()
    // 卡片宽高比按锚点里记的
    expect(h.host.api.query({ ids: [local], scope: 'all' })).toMatchObject({ aspects: [100 / 150] })
  })

  it('原素材进回收站，局部跟着；恢复时一起回来，之前单独删掉的不动；撤销也一样', async () => {
    const h = setup()
    const img = await picture(h)
    const a = h.host.api.create(region(img, 0, 0, 0.25, 0.5)) as string
    const b = h.host.api.create(region(img, 0.5, 0.5, 0.25, 0.25)) as string
    h.host.api.trash([b])
    h.host.api.trash([img])
    expect(h.host.store.isTrashed(a)).toBe(true)
    h.host.api.restore([img])
    expect(h.host.store.isTrashed(img)).toBe(false)
    expect(h.host.store.isTrashed(a)).toBe(false)
    expect(h.host.store.isTrashed(b)).toBe(true)

    h.host.api.trash([img])
    expect(h.host.api.undo()).toBe('移到回收站（1 项）')
    expect(h.host.store.isTrashed(a)).toBe(false)
  })
})

describe('一句话拆成笔记和标签', () => {
  it('#词 是标签，其余是笔记；全角＃也认', () => {
    expect(parseAnnotation('反光处理很好 #光影 #构图')).toEqual({ note: '反光处理很好', tags: ['光影', '构图'] })
    expect(parseAnnotation('＃光影，留白可以借鉴')).toEqual({ note: '留白可以借鉴', tags: ['光影'] })
    expect(parseAnnotation('#光影 #光影')).toEqual({ note: '', tags: ['光影'] })
  })
})

// 文本区间（设计文档 11.10）：存原文片段和前后文；原文改了，局部重新检查还找不找得到（失配）。
describe('文本区间', () => {
  const range = (target: string, quote: string) => ({
    anchor: { target, type: '文本区间', quote, prefix: '', suffix: '', offset: 0, aspect: 2 },
    note: { text: '这句好' }
  })

  it('原文里找得到那一句；改了原文，局部跟着重新检查；撤销后又找得到', async () => {
    const h = setup()
    const [doc] = await h.host.api.ingest([{ type: 'text', text: '## 留白\n\n画面里**空的地方**也是构图。\n\n- 留白给视线休息的位置' }])
    // 片段取自排好版的文字：没有 Markdown 记号，跨行
    const local = h.host.api.create(range(doc, '空的地方也是构图。留白给视线')) as string
    await h.host.scheduler.idle()
    expect(h.host.store.blocksOf(local).place.data).toEqual({ found: true })

    h.host.api.put(doc, 'text', { content: '## 留白\n\n全部改写了。' })
    await h.host.scheduler.idle()
    expect(h.host.store.blocksOf(local).place.data).toEqual({ found: false })
    expect(ids(h.host.api.query({ where: [{ op: 'eq', kind: 'place', field: 'found', value: false }] }))).toEqual([local])

    h.host.api.undo()
    await h.host.scheduler.idle()
    expect(h.host.store.blocksOf(local).place.data).toEqual({ found: true })
    // 原文片段能搜到
    expect(ids(h.host.api.query({ text: '视线' })).sort()).toEqual([doc, local].sort())
  })

  it('文档（.md 文件）里的一句；链接不算在片段里', async () => {
    const h = setup()
    const path = join(tempDir(), '笔记.md')
    writeFileSync(path, '参考 [[01K7Q3M5T8ZR6Y2J4N9X0W1V3B|作品]] 的配色，冷暖分明')
    const [doc] = await h.host.api.ingest([{ type: 'file', path }])
    await h.host.scheduler.idle()
    const local = h.host.api.create(range(doc, '参考  的配色，冷暖分明')) as string
    await h.host.scheduler.idle()
    expect(h.host.store.blocksOf(local).place.data).toEqual({ found: true })
  })
})

describe('局部跟着原素材变', () => {
  it('原图的代表图换了：局部重新裁（加工的新鲜度包括依附目标上的数据块）', async () => {
    const h = setup()
    const img = await picture(h)
    const local = h.host.api.create(region(img, 0, 0, 0.25, 0.5)) as string
    await h.host.scheduler.idle()
    const before = h.host.store.blocksOf(local).still.seq
    // 换一张全蓝的图当原图的代表图
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#0000ff' } }).png().toFile(join(h.root, 'cache', 'blue.png'))
    h.host.store.put(img, 'still', { path: join('cache', 'blue.png'), source: 999 })
    await h.host.scheduler.idle()
    const after = h.host.store.blocksOf(local)
    expect(after.still.seq).not.toBe(before)
  })
})
