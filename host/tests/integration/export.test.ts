// 导出（设计文档 11.12）：一组素材写成一个文件夹（索引.md、素材/、文字/、局部/），Obsidian、Typora 能直接打开。
// 一个身份写成什么文件由认识它的插件决定；属性由数据块定义生成；重名加编号；失败的跳过并记下。

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { templateKindId } from '../fixtures/legacy-fields/blocks'
import type { ExportResult } from '../../src/shared/rpc'
import { wikiLinkText } from '../../src/shared/wikilink'
import { openHost, tempDir } from '../helpers/helpers'
import { legacyCorePlugins as corePlugins } from '../helpers/legacy-plugins'
import type { CorePlugin } from '../../src/plugin-api/core/contracts'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

async function library() {
  const h = openHost()
  cleanup = h.cleanup
  const { host } = h
  const image = async (dir: string, color: string) => {
    const path = join(tempDir(dir), '海边.png')
    await sharp({ create: { width: 400, height: 300, channels: 3, background: color } }).png().toFile(path)
    return (await host.api.ingest([{ type: 'file', path }]))[0]
  }
  const sea = await image('a-', '#3366cc')
  const sea2 = await image('b-', '#cc6633')
  const docPath = join(tempDir(), '读书笔记.md')
  writeFileSync(docPath, '# 读书笔记\n\n留白')
  const [doc] = await host.api.ingest([{ type: 'file', path: docPath }])
  const [other] = await host.api.ingest([{ type: 'text', text: '没导出的那篇' }])

  host.api.put(sea, 'tags', { values: ['光影', '海报'] })
  host.api.put(sea, 'status', { value: '进行中' })
  host.api.put(sea, 'note', { text: '冷暖对比很漂亮' })
  const tpl = host.api.create({ template: { title: '影视片段', fields: [{ id: 'fname', title: '片名', type: 'text' }] } }) as string
  host.api.put(sea, templateKindId(tpl), { fname: '花样年华' })
  host.api.create({ anchor: { target: sea, type: '图片区域', x: 0, y: 0, w: 0.5, h: 0.5, aspect: 1 }, note: { text: '反光' }, tags: { values: ['细节'] } })

  const [text] = await host.api.ingest([
    { type: 'text', text: `# 配色笔记\n\n参考 ${wikiLinkText(sea, '海边')}\n\n${wikiLinkText(sea, '海边', true)}\n\n还有 ${wikiLinkText(other, '没导出的')}` }
  ])
  host.api.put(text, 'tags', { values: ['灵感'] })
  host.api.create({ anchor: { target: text, type: '文本区间', quote: '参考', prefix: '', suffix: '', offset: 0, aspect: 2 }, note: { text: '这句' } })
  await host.scheduler.idle()

  const ids = [sea, sea2, text, doc]
  const titles = { [sea]: '海边.png', [sea2]: '海边.png', [text]: '配色笔记', [doc]: '读书笔记.md' }
  return { ...h, ids, titles, sea, sea2, text, doc }
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8')

describe('导出', () => {
  it('PDF 摘录独立导出或随原文导出都包含原句与页码；文字复用笔记和标签贡献', async () => {
    const h = openHost(); cleanup = h.cleanup
    const text = await h.host.api.create({ text: { content: '# 阅读记录' }, note: { text: '多行\n笔记' }, tags: { values: ['研究'] } })
    const quote = await h.host.api.create({ anchor: { target: text, type: 'PDF摘录', quote: '原文摘录', sourceHash: 'f', page: 2, fragments: [{ page: 2, quote: '原文摘录', rects: [{ x: .1, y: .1, w: .2, h: .1 }] }] } })
    const preview = await h.host.api.exportPreview([quote])
    expect(preview.unsupported).toBe(0)
    const single = await h.host.api.exportRun({ ids: [quote], titles: {}, parent: tempDir(), name: '单条' })
    expect(single.failed).toEqual([])
    expect(read(single.dir, '索引.md')).toContain('“原文摘录” —— PDF 第 2 页')
    const all = await h.host.api.exportRun({ ids: [text, quote], titles: { [text]: '阅读记录' }, parent: tempDir(), name: '原文' })
    expect(all.failed).toEqual([])
    expect(read(all.dir, '索引.md')).toContain('- “原文摘录” —— PDF 第 2 页')
    expect(read(all.dir, '文字/阅读记录.md')).toContain('tags: ["研究"]')
    expect(read(all.dir, '文字/阅读记录.md')).toContain('笔记: "多行\\n笔记"')
    await h.host.scheduler.idle()
  })

  it('专用排版停用后字段仍输出，重新启用恢复；片段抛错时报告并退回通用字段', async () => {
    let h = openHost(); cleanup = () => h.cleanup()
    const id = await h.host.api.create({ text: { content: '正文' }, note: { text: '保留笔记' }, tags: { values: ['保留标签'] } })
    const root = h.root
    await h.host.scheduler.idle(); await h.host.api.setPlugins(['note', 'tags']); h.host.close()
    h = openHost(undefined, undefined, root)
    const off = await h.host.api.exportRun({ ids: [id], titles: {}, parent: tempDir(), name: '停用' })
    expect(off.failed).toEqual([])
    expect(read(off.dir, '索引.md')).toContain('- 笔记：保留笔记')
    expect(read(off.dir, '索引.md')).toContain('- 标签：保留标签')
    await h.host.scheduler.idle(); await h.host.api.setPlugins([]); h.host.close()
    h = openHost(undefined, undefined, root)
    const on = await h.host.api.exportRun({ ids: [id], titles: {}, parent: tempDir(), name: '恢复' })
    expect(read(on.dir, '索引.md')).toContain('> 保留笔记')
    await h.host.scheduler.idle(); h.host.close()
    const broken = corePlugins.map(p => p.id === 'note' ? { ...p, exportSections: p.exportSections!.map(s => ({ ...s, render: () => { throw new Error('排版失败') } })) } : p) satisfies CorePlugin[]
    h = openHost(broken, undefined, root)
    expect((await h.host.api.exportPreview([id])).problems[0]).toContain('排版失败')
    const fallback = await h.host.api.exportRun({ ids: [id], titles: {}, parent: tempDir(), name: '错误回退' })
    expect(fallback.failed[0].reason).toContain('排版失败')
    expect(read(fallback.dir, '索引.md')).toContain('- 笔记：保留笔记')
    await h.host.scheduler.idle()
  })

  it('预览：几项、跟着一起的批注、每个文件夹几个文件多大', async () => {
    const { host, ids } = await library()
    const p = host.api.exportPreview(ids) as { items: number; locals: number; folders: { folder: string; count: number; bytes: number }[] }
    expect(p.items).toBe(4)
    expect(p.locals).toBe(2)
    expect(p.folders.find((f) => f.folder === '素材')).toMatchObject({ count: 3 })
    expect(p.folders.find((f) => f.folder === '文字')).toMatchObject({ count: 1 })
    expect(p.folders.find((f) => f.folder === '局部')).toMatchObject({ count: 1 })
  })

  it('写成一个文件夹：原文件（重名加编号）、文字写成 Markdown（属性、改写的链接）、裁好的局部、索引', async () => {
    const { host, ids, titles } = await library()
    const parent = tempDir('rm-export-')
    const r = (await host.api.exportRun({ ids, titles, parent, name: '导出测试' })) as ExportResult
    expect(r.dir).toBe(join(parent, '导出测试'))
    expect(r.failed).toEqual([])
    expect(r.written).toBe(5)
    for (const f of ['素材/海边.png', '素材/海边 (2).png', '素材/读书笔记.md', '局部/反光.jpg', '文字/配色笔记.md', '索引.md']) {
      expect(existsSync(join(r.dir, f))).toBe(true)
    }

    const md = read(r.dir, '文字/配色笔记.md')
    expect(md).toMatch(/^---\ntags: \["灵感"\]\n---\n\n# 配色笔记/)
    expect(md).toContain('参考 [海边](../素材/海边.png)')
    expect(md).toContain('![海边](../素材/海边.png)')
    expect(md).toContain('还有 没导出的')

    const index = read(r.dir, '索引.md')
    expect(index).toContain('## 海边.png\n\n![海边.png](素材/海边.png)')
    expect(index).toContain('- 标签：光影、海报')
    expect(index).toContain('- 状态：进行中')
    expect(index).toContain('- 片名：花样年华')
    expect(index).toContain('> 冷暖对比很漂亮')
    expect(index).toContain('- ![反光](局部/反光.jpg) —— 反光 —— #细节')
    expect(index).toContain('- “参考” —— 这句')
    // 重名加了编号；路径里的空格、括号转义
    expect(index).toContain('![海边.png](素材/海边%20%282%29.png)')

    // 再导出一次：不覆盖，文件夹加编号
    const again = (await host.api.exportRun({ ids, titles, parent, name: '导出测试' })) as ExportResult
    expect(again.dir).toBe(join(parent, '导出测试 (2)'))
  })

  it('某一项失败（原文件不见了）：跳过并记下原因，其余照常写，索引里也说明', async () => {
    const { host, ids, titles, sea2 } = await library()
    rmSync(host.lib.files.readable(String(host.store.blocksOf(sea2).file.data.path)))
    const r = (await host.api.exportRun({ ids, titles, parent: tempDir(), name: '有失败的' })) as ExportResult
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].title).toBe('海边.png')
    expect(existsSync(join(r.dir, '素材/海边.png'))).toBe(true)
    expect(read(r.dir, '索引.md')).toContain('（没有导出成功：')
  })
})
