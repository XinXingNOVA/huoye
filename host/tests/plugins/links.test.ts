// 双链与嵌入（设计文档 11.9）：文字里的 [[…]] 解析成关联引用，反向引用索引给出"提到它的"。

import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseWikiLinks, stripWikiLinks, wikiLinkText } from '../../src/shared/wikilink'
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
const mentioning = (h: ReturnType<typeof setup>, id: string) =>
  ids(h.host.api.query({ where: [{ op: 'eq', kind: 'links', field: 'targets', value: id }] })).sort()

async function file(h: ReturnType<typeof setup>, name: string, data: string) {
  const path = join(tempDir(), name)
  writeFileSync(path, data)
  const [id] = await h.host.api.ingest([{ type: 'file', path }])
  return id
}

describe('写法', () => {
  it('[[目标]]、[[目标|显示的字]]、![[嵌入]]；插入时显示的字里去掉方括号、竖线', () => {
    const id = '01K7Q3M5T8ZR6Y2J4N9X0W1V3B'
    expect(parseWikiLinks(`看 [[${id}|作品 24]] 和 ![[pic.png]]，还有 [[笔记]]`)).toMatchObject([
      { embed: false, target: id, label: '作品 24' },
      { embed: true, target: 'pic.png', label: undefined },
      { embed: false, target: '笔记' }
    ])
    expect(wikiLinkText(id, 'a|b [c]', true)).toBe(`![[${id}|a b c]]`)
    expect(stripWikiLinks(`看 [[${id}|作品]]、[[${id}]] 和 ![[pic.png]]`)).toBe('看 作品、 和 pic.png')
  })
})

describe('反向链接', () => {
  it('文字提到了谁：ID 和文件名都认；提到它的文字反过来查得到；提到自己不算', async () => {
    const h = setup()
    const img = await file(h, '作品_24.png', 'x')
    const note = await file(h, '读书笔记.md', '# 读书笔记')
    const [t] = await h.host.api.ingest([{ type: 'text', text: '先占位' }])
    h.host.api.put(t, 'text', { content: `配色参考 ${wikiLinkText(img, '作品_24.png')}\n\n![[读书笔记]]\n\n[[${t}|自己]]` })
    await h.host.scheduler.idle()
    expect(h.host.store.blocksOf(t).links.data.targets).toEqual([img, note])
    expect(mentioning(h, img)).toEqual([t])
    expect(mentioning(h, note)).toEqual([t])
  })

  it('文档（.md 文件）里的 Obsidian 写法：按文件名找到', async () => {
    const h = setup()
    const pic = await file(h, 'pic.png', 'x')
    const doc = await file(h, '旅行.md', '# 旅行\n\n![[pic.png]]')
    await h.host.scheduler.idle()
    expect(mentioning(h, pic)).toEqual([doc])
  })

  it('删掉链接，反向链接就没了；被提到的进回收站，链接还在；提到它的文字进回收站，就不算了', async () => {
    const h = setup()
    const img = await file(h, 'a.png', 'x')
    const [t, u] = await h.host.api.ingest([
      { type: 'text', text: `见 ${wikiLinkText(img, 'a.png')}` },
      { type: 'text', text: `也见 ${wikiLinkText(img, 'a.png')}` }
    ])
    await h.host.scheduler.idle()
    expect(mentioning(h, img)).toEqual([t, u].sort())

    h.host.api.put(u, 'text', { content: '不提了' })
    await h.host.scheduler.idle()
    expect(h.host.store.blocksOf(u).links).toBeUndefined()
    expect(mentioning(h, img)).toEqual([t])

    h.host.api.trash([img])
    expect(h.host.store.isTrashed(t)).toBe(false)
    expect(h.host.store.blocksOf(t).links.data.targets).toEqual([img])

    h.host.api.trash([t])
    expect(mentioning(h, img)).toEqual([])
  })

  it('搜索、摘要里链接显示成它的字', async () => {
    const h = setup()
    const img = await file(h, 'a.png', 'x')
    const [t] = await h.host.api.ingest([{ type: 'text', text: `配色参考 ${wikiLinkText(img, '海边的那张')} 很好` }])
    expect(ids(h.host.api.query({ text: '海边' }))).toEqual([t])
    const s = (h.host.api.snippets([t], '海边') as Record<string, { text: string }>)[t]
    expect(s.text).toBe('配色参考 海边的那张 很好')
  })
})
