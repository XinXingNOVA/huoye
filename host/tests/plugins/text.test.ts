// 文字（设计文档 11.7）：摘录是文本块，存 Markdown，网页上的格式保留、来源记下；
// 文档是文件，文字插件读出正文（认 UTF-8 和 GB18030）；当前编辑发布新版本。

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { htmlToMarkdown } from '../../src/plugins/text/lib/html'
import { openHost, saveTextFile, tempDir } from '../helpers/helpers'

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

const CHROME_HTML = `<meta charset='utf-8'><h2 style="color:red">留白</h2><p>画面里<b>空的地方</b>也是构图，见<a href="https://example.com/a">这篇</a>。</p><ul><li>上下</li><li>左右</li></ul><script>track()</script>`

describe('网页上复制来的文字', () => {
  it('有格式的 HTML 转成 Markdown；只有样式没有格式时用纯文字', () => {
    expect(htmlToMarkdown(CHROME_HTML)).toBe('## 留白\n\n画面里**空的地方**也是构图，见[这篇](https://example.com/a)。\n\n- 上下\n- 左右')
    expect(htmlToMarkdown('<div><span style="color:#c00">const a = 1</span><br><span>b()</span></div>')).toBeUndefined()
  })

  it('粘贴：存 Markdown，记下来源（网址、网站）；没有来源时不记', async () => {
    const { host } = setup()
    const [a, b] = await host.api.ingest([
      { type: 'text', text: '留白\n画面里空的地方也是构图', html: CHROME_HTML, source: { url: 'https://www.example.com/a?x=1' } },
      { type: 'text', text: '随手一句' }
    ])
    const blocks = host.store.blocksOf(a)
    expect(String(blocks.text.data.content)).toMatch(/^## 留白/)
    expect(blocks.source.data).toEqual({ url: 'https://www.example.com/a?x=1', site: 'example.com' })
    expect(host.store.blocksOf(b).text.data.content).toBe('随手一句')
    expect(host.store.blocksOf(b).source).toBeUndefined()
    // 侧栏按网站筛选
    expect(host.api.facet('source', 'site')).toEqual([{ value: 'example.com', count: 1 }])
  })

  it('卡片的形状按文字长短：一句话是扁的，长文是高的', async () => {
    const { host } = setup()
    const [short, long] = await host.api.ingest([
      { type: 'text', text: '一句话' },
      { type: 'text', text: '很长的一段。'.repeat(200) }
    ])
    const aspect = (id: string) => (host.api.query({ ids: [id], scope: 'all' }) as { aspects: number[] }).aspects[0]
    expect([aspect(short), aspect(long)]).toEqual([2, 0.75])
  })
})

describe('文档：文本文件', () => {
  async function ingestFile(h: ReturnType<typeof setup>, name: string, data: string | Buffer, source?: string) {
    const path = join(tempDir(), name)
    writeFileSync(path, data)
    const [id] = await h.host.api.ingest([{ type: 'file', path, ...(source ? { source: { url: source } } : {}) }])
    await h.host.scheduler.idle()
    return id
  }

  it('读出 Markdown 的正文；旧的 GB18030 文本文件也认得；不是文本的不读', async () => {
    const h = setup()
    const md = await ingestFile(h, '读书笔记.md', '﻿# 读书笔记\n\n- 第一条', 'https://notes.example.org/x')
    const gbk = await ingestFile(h, '旧笔记.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) // "中文"
    const bin = await ingestFile(h, '其实是二进制.txt', Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x14]))

    expect(h.host.store.blocksOf(md).body.data).toMatchObject({ content: '# 读书笔记\n\n- 第一条', format: 'markdown', encoding: 'UTF-8' })
    expect(h.host.store.blocksOf(md).source.data.site).toBe('notes.example.org')
    expect(h.host.store.blocksOf(gbk).body.data).toMatchObject({ content: '中文', format: 'plain', encoding: 'GB18030' })
    expect(h.host.store.blocksOf(bin).body).toBeUndefined()
  })

  it('同一个文件再收录一次：认回原来的身份，不补记来源', async () => {
    const h = setup()
    const a = await ingestFile(h, '笔记.md', '# 同一个')
    const b = await ingestFile(h, '笔记副本.md', '# 同一个', 'https://example.com/')
    expect(b).toBe(a)
    expect(h.host.store.blocksOf(a).source).toBeUndefined()
  })

  it('编辑文档发布新版，大小、哈希、正文跟着变；原版本字节仍可读取', async () => {
    const h = setup()
    const id = await ingestFile(h, '草稿.md', '# 草稿\n')
    const file = () => h.host.store.blocksOf(id).file.data
    const onDisk = () => readFileSync(h.host.lib.files.readable(String(file().path)), 'utf8')
    const before = { ...file() }

    await saveTextFile(h.host, id, '# 定稿\n\n改好了')
    await h.host.scheduler.idle()
    expect(onDisk()).toBe('# 定稿\n\n改好了')
    expect(file().size).toBe(Buffer.byteLength('# 定稿\n\n改好了'))
    expect(file().hash).not.toBe(before.hash)
    expect(h.host.store.blocksOf(id).body.data.content).toBe('# 定稿\n\n改好了')

    expect(file().path).not.toBe(before.path)
    expect(readFileSync(h.host.lib.files.readable(String(before.path)), 'utf8')).toBe('# 草稿\n')
  })

  it('旧同步命令已退出，预演和执行均拒绝且版本原件保留', async () => {
    const h = setup()
    const id = await ingestFile(h, '草稿.md', '# 草稿\n')
    const path = h.host.lib.files.readable(String(h.host.store.blocksOf(id).file.data.path))
    expect(() => h.host.api.preview('file', 'replace', { id, content: '改' })).toThrow('没有命令')
    expect(readFileSync(path, 'utf8')).toBe('# 草稿\n')
    expect(() => h.host.api.run('file', 'replace', { id: 'nope', content: '改' })).toThrow()
  })
})
