// PDF 插件（设计文档 11.11）：用系统的 cupsfilter 把一段中文转成两页的 PDF，走一遍真实的读取。
// 没有 cupsfilter（不是 macOS）时跳过。

import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pageAt } from '../../src/plugins/pdf/blocks'
import { openHost, tempDir } from '../helpers/helpers'

const cupsfilter = ['/usr/sbin/cupsfilter', '/usr/bin/cupsfilter'].find(existsSync)
const dir = tempDir('rm-pdf-')
let twoPages: string

beforeAll(() => {
  if (!cupsfilter) return
  const lines = ['留白的力量', '画面里空的地方也是构图。', ...Array.from({ length: 70 }, (_, i) => `第 ${i + 3} 行`), '第二页：节奏与对比']
  const txt = join(dir, '笔记.txt')
  writeFileSync(txt, lines.join('\n'))
  twoPages = join(dir, '设计笔记.pdf')
  writeFileSync(twoPages, execFileSync(cupsfilter, ['-m', 'application/pdf', txt], { stdio: ['ignore', 'pipe', 'ignore'] }))
}, 30_000)

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

describe.skipIf(!cupsfilter)('PDF', () => {
  it('页数、页面大小；第一页作代表图，缩略图由预览插件接上；卡片按页面的宽高比', async () => {
    const { host, root } = setup()
    const [id] = await host.api.ingest([{ type: 'file', path: twoPages }])
    await host.scheduler.idle()
    const b = host.store.blocksOf(id)
    expect(b.pdf.data).toMatchObject({ pages: 2, width: 612, height: 792 })
    const still = await sharp(join(root, String(b.still.data.path))).metadata()
    expect(Math.max(still.width!, still.height!)).toBe(1600)
    expect(b.thumb).toBeTruthy()
    expect((host.api.query({ ids: [id], scope: 'all' }) as { aspects: number[] }).aspects[0]).toBeCloseTo(612 / 792, 3)
  })

  it('抽出文字：全文搜索自动接上；兼容字符换成普通汉字；知道每个字在第几页', async () => {
    const { host } = setup()
    const [id] = await host.api.ingest([{ type: 'file', path: twoPages }])
    await host.scheduler.idle()
    const t = host.store.blocksOf(id).pdftext.data
    expect(String(t.content)).toContain('留白的力量')
    expect(t.pages).toHaveLength(2)
    expect(pageAt(t.pages as number[], String(t.content).indexOf('节奏与对比'))).toBe(2)
    expect((host.api.query({ text: '节奏 对比' }) as { ids: string[] }).ids).toEqual([id])
    // 这个字体把"页"画成部首"⻚"：换回普通的字，搜"第二页"才搜得到
    expect(String(t.content)).toContain('第二页：节奏与对比')
    expect((host.api.query({ text: '第二页' }) as { ids: string[] }).ids).toEqual([id])
    const s = (host.api.snippets([id], '留白') as Record<string, { label: string; text: string }>)[id]
    expect(s.label).toBe('PDF 正文')
  })

  it('不是真的 PDF：读不出来记成失败，它仍然是素材', async () => {
    const { host } = setup()
    const fake = join(tempDir(), '坏的.pdf')
    writeFileSync(fake, 'not a pdf')
    const [id] = await host.api.ingest([{ type: 'file', path: fake }])
    await host.scheduler.idle()
    const [view] = host.store.get([id])
    expect(view.blocks.pdf).toBeUndefined()
    expect(view.failures['pdf.probe']).toBeTruthy()
    expect((host.api.query({}) as { ids: string[] }).ids).toEqual([id])
  })
})
