// 全文搜索（设计文档 11.8）：插件在字段上声明可搜索，宿主随写入维护索引。
// 中文按字、短语匹配（和 ⌘F 一样是子串）；西文按词、前缀、忽略大小写和变音符号；几个词可以落在不同字段上。

import { afterEach, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { templateKindId } from '../fixtures/legacy-fields/blocks'
import { noChecks, searchTextFor, searchesOf, splitConditions, withTextSearch, type Query, type Snippet, type TextSearch } from '../../src/shared/query'
import { openHost, tempDir } from '../helpers/helpers'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup(root?: string) {
  const h = openHost(undefined, undefined, root)
  cleanups.push(h.cleanup)
  return h
}

const ids = (r: unknown) => (r as { ids: string[] }).ids
const snippets = (r: unknown) => r as Record<string, Snippet>

async function library() {
  const h = setup()
  const [a, b, c] = await h.host.api.ingest([
    { type: 'text', text: '画面里空的地方也是构图，留白给视线休息的位置' },
    { type: 'text', text: 'Design Systems 与 café 的招牌' },
    { type: 'text', text: '保留白色的背景' }
  ])
  return { ...h, a, b, c, find: (text: string) => ids(h.host.api.query({ text })).sort() }
}

describe('全文搜索', () => {
  it('中文是子串：搜"留白"找到含这两个字连在一起的；几个词都要有', async () => {
    const { find, a, c } = await library()
    expect(find('留白')).toEqual([a, c].sort())
    expect(find('留白 构图')).toEqual([a])
    expect(find('构图 招牌')).toEqual([])
    expect(find('白色')).toEqual([c])
  })

  it('西文按词、最后一个词按前缀；忽略大小写和变音符号；只有标点的词不算条件', async () => {
    const { find, b, host } = await library()
    expect(find('desig')).toEqual([b])
    expect(find('SYSTEMS')).toEqual([b])
    expect(find('cafe')).toEqual([b])
    expect(find('，。')).toEqual(ids(host.api.query({})).sort())
  })

  it('几个词可以落在不同字段上：笔记里有一个，标签里有另一个；文件名也能搜', async () => {
    const h = setup()
    const path = join(tempDir(), '海报_初稿.png')
    writeFileSync(path, 'not really a png')
    const [img] = await h.host.api.ingest([{ type: 'file', path }])
    h.host.api.put(img, 'note', { text: '右下角的留白可以借鉴' })
    h.host.api.put(img, 'tags', { values: ['版式'] })
    const find = (text: string) => ids(h.host.api.query({ text }))
    expect(find('留白 版式')).toEqual([img])
    expect(find('海报 初稿')).toEqual([img])
    // 和其他条件一起用
    expect(ids(h.host.api.query({ text: '留白', has: ['tags'] }))).toEqual([img])
    expect(ids(h.host.api.query({ text: '留白', has: ['image'] }))).toEqual([])
  })

  it('改了、删了、撤销了，索引都跟着变；回收站里的不在"全部"的结果里', async () => {
    const { host, find, a, c } = await library()
    host.api.put(a, 'text', { content: '换成别的内容了' })
    expect(find('留白')).toEqual([c])
    expect(find('别的内容')).toEqual([a])
    host.api.undo()
    expect(find('留白')).toEqual([a, c].sort())
    host.api.trash([c])
    expect(find('留白')).toEqual([a])
    expect(ids(host.api.query({ text: '留白', scope: 'trash' }))).toEqual([c])
  })

  it('命中的那一句：出自哪里、词的位置；长文本优先于标签', async () => {
    const { host, a } = await library()
    host.api.put(a, 'tags', { values: ['留白'] })
    const s = snippets(host.api.snippets([a], '留白 视线'))[a]
    expect(s.label).toBe('文本')
    expect(s.text).toContain('留白给视线休息')
    expect(s.marks.map(([x, y]) => s.text.slice(x, y))).toEqual(['留白', '视线'])
    expect(host.api.snippets([a], '找不到')).toEqual({})
  })

  it('模板的文本字段可以搜；改成数字后就不在索引里了', () => {
    const h = setup()
    const tpl = h.host.api.create({ template: { title: '影视片段', fields: [{ id: 'fname', title: '片名', type: 'text' }] } }) as string
    const kind = templateKindId(tpl)
    const x = h.host.api.create({ text: { content: '一段' }, [kind]: { fname: '花样年华' } }) as string
    expect(ids(h.host.api.query({ text: '年华' }))).toEqual([x])
    expect(snippets(h.host.api.snippets([x], '年华'))[x].label).toBe('影视片段 · 片名')
    h.host.api.run('fields', 'changeType', { template: tpl, field: 'fname', type: 'number' })
    expect(ids(h.host.api.query({ text: '年华' }))).toEqual([])
  })

  it('派生库删掉、重新打开：索引重建；停用的插件留下的文字照样能搜', async () => {
    const h = setup()
    const [x] = await h.host.api.ingest([{ type: 'text', text: '一句摘录' }])
    h.host.api.put(x, 'note', { text: '冷暖对比' })
    h.host.api.setPlugins(['note'])
    h.host.close()
    rmSync(join(h.root, 'derived.db'), { force: true })
    const again = setup(h.root)
    expect(again.host.plan.off.get('note')).toBe('已停用')
    expect(ids(again.host.api.query({ text: '冷暖' }))).toEqual([x])
    expect(ids(again.host.api.query({ text: '摘录' }))).toEqual([x])
  })

  it('放进一个"搜索结果"的视图：不含这些词的被拒绝，说明原因', async () => {
    const { host, a, b } = await library()
    const r = await host.api.admit([a, b], { text: '留白' })
    expect(r.accepted).toEqual([a])
    expect(r.rejected).toEqual([{ id: b, reason: '含有「留白」' }])
  })
})

describe('数据块 → 字段 → 内容', () => {
  it('同一个词在不同数据块里：限定笔记后不混入正文，并可与标签筛选组合', async () => {
    const { host, a, b } = await library()
    host.api.put(b, 'note', { text: '留白参考' })
    host.api.put(b, 'tags', { values: ['收藏'] })
    host.api.put(a, 'tags', { values: ['收藏'] })
    const search = [{ kind: 'note', text: '留白' }]
    expect(ids(host.api.query({ search }))).toEqual([b])
    expect(ids(host.api.query({ search, where: [{ op: 'eq', kind: 'tags', field: 'values', value: '收藏' }] }))).toEqual([b])
    expect(ids(host.api.query({ search, where: [{ op: 'eq', kind: 'tags', field: 'values', value: '其他' }] }))).toEqual([])
    expect(ids(host.api.query({ search, has: ['file'] }))).toEqual([])
    host.api.trash([b])
    expect(ids(host.api.query({ search }))).toEqual([])
    expect(ids(host.api.query({ search, scope: 'trash' }))).toEqual([b])
  })

  it('模板各自独立；块内的多个词可落在不同字段，指定字段后全部词必须在该字段', () => {
    const { host } = setup()
    const fields = [{ id: 'ftitle', title: '片名', type: 'text' }, { id: 'fdirector', title: '导演', type: 'text' }]
    const a = host.api.create({ template: { title: '影视资料', fields } }) as string
    const b = host.api.create({ template: { title: '其他资料', fields } }) as string
    const kind = templateKindId(a), other = templateKindId(b)
    const x = host.api.create({ text: { content: '王家卫' }, [kind]: { ftitle: '花样年华', fdirector: '王家卫' } }) as string
    host.api.create({ text: { content: '片段' }, [other]: { ftitle: '花样年华', fdirector: '王家卫' } })
    const find = (s: TextSearch) => ids(host.api.query({ search: [s] }))
    expect(find({ kind, text: '年华 王家卫' })).toEqual([x])
    expect(find({ kind, field: 'fdirector', text: '王家卫' })).toEqual([x])
    expect(find({ kind, field: 'ftitle', text: '王家卫' })).toEqual([])
    expect(find({ kind, field: 'fdirector', text: '年华 王家卫' })).toEqual([])
    const s = snippets(host.api.snippets([x], [{ kind, field: 'fdirector', text: '王家卫' }]))[x]
    expect(s).toMatchObject({ kind, field: 'fdirector', label: '影视资料 · 导演', text: '王家卫' })
  })

  it('范围随标签、笔记编辑与撤销更新；摘要只使用所选范围', async () => {
    const { host, a } = await library()
    host.api.put(a, 'tags', { values: ['留白'] })
    const search = [{ kind: 'tags', field: 'values', text: '留白' }]
    expect(snippets(host.api.snippets([a], search))[a]).toMatchObject({ kind: 'tags', field: 'values', text: '留白', label: '标签' })
    host.api.put(a, 'tags', { values: ['布局'] })
    expect(ids(host.api.query({ search }))).toEqual([])
    expect(host.api.snippets([a], search)).toEqual({})
    host.api.undo()
    expect(ids(host.api.query({ search }))).toEqual([a])
  })

  it('视图已有条件与不同范围的临时搜索取交集，序列化保存后不改变范围', async () => {
    const { host, a, c } = await library()
    host.api.put(a, 'note', { text: '排版参考' })
    host.api.put(c, 'tags', { values: ['参考'] })
    const base: Query = { text: '留白', search: [{ kind: 'text', field: 'content', text: '视线' }] }
    const combined = withTextSearch(base, { kind: 'note', field: 'text', text: '参考' })
    const viewId = host.api.create({ view: { title: '组合搜索', query: combined, layout: 'masonry' } }) as string
    const saved = (await host.api.get([viewId]))[0].blocks.view.data.query as Query
    expect(searchesOf(saved)).toEqual([{ text: '留白' }, { kind: 'text', field: 'content', text: '视线' }, { kind: 'note', field: 'text', text: '参考' }])
    expect(ids(host.api.query(saved))).toEqual([a])
    expect(base.search).toHaveLength(1)
    expect(snippets(host.api.snippets([a], searchesOf(saved)))[a].label).toBe('笔记')
    expect(withTextSearch(base, { kind: 'file', text: '  ' })).toBe(base)
    expect(noChecks({ search: [{ kind: 'tags', text: '' }] })).toBe(true)
  })

  it('字段改名仍用原 ID 查找；删字段或改类型后不退回全文，撤销恢复', () => {
    const { host } = setup()
    const tpl = host.api.create({ template: { title: '影视', fields: [{ id: 'fname', title: '片名', type: 'text' }] } }) as string
    const kind = templateKindId(tpl)
    const x = host.api.create({ text: { content: '花样年华' }, [kind]: { fname: '花样年华' } }) as string
    const search = [{ kind, field: 'fname', text: '年华' }]
    host.api.put(tpl, 'template', { title: '影片', fields: [{ id: 'fname', title: '名称', type: 'text' }] })
    expect(ids(host.api.query({ search }))).toEqual([x])
    expect(snippets(host.api.snippets([x], search))[x].label).toBe('影片 · 名称')
    host.api.run('fields', 'changeType', { template: tpl, field: 'fname', type: 'number' })
    expect(ids(host.api.query({ search }))).toEqual([])
    expect(host.api.snippets([x], search)).toEqual({})
    host.api.undo()
    expect(ids(host.api.query({ search }))).toEqual([x])
    for (const s of [{ kind: 'missing', text: '年华' }, { kind, field: 'missing', text: '年华' }, { field: 'content', text: '年华' }]) {
      expect(ids(host.api.query({ search: [s] }))).toEqual([])
      expect(host.api.snippets([x], [s])).toEqual({})
    }
  })

  it('范围也用于视图准入，拒绝原因指出数据块与字段', async () => {
    const { host, a, b } = await library()
    host.api.put(b, 'note', { text: '留白参考' })
    const q: Query = { search: [{ kind: 'note', field: 'text', text: '留白' }] }
    expect(noChecks(splitConditions(q, (id) => host.reg.kind(id))!.check)).toBe(false)
    const r = await host.api.admit([a, b], q)
    expect(r.accepted).toEqual([b])
    expect(r.rejected).toEqual([{ id: a, reason: '笔记 · 内容中含有「留白」' }])
  })

  it('重启与停用插件后仍可限定范围搜索保留的数据', async () => {
    const h = setup()
    const [x] = await h.host.api.ingest([{ type: 'text', text: '笔记外的词' }])
    h.host.api.put(x, 'note', { text: '冷暖对比' })
    h.host.api.setPlugins(['note'])
    h.host.close()
    const again = setup(h.root)
    expect(ids(again.host.api.query({ search: [{ kind: 'note', field: 'text', text: '冷暖' }] }))).toEqual([x])
    expect(ids(again.host.api.query({ search: [{ kind: 'text', field: 'content', text: '冷暖' }] }))).toEqual([])
  })

  it('阅读器只高亮自己正文范围的词，不把标签、作者或摘录的搜索拿去定位正文', () => {
    const q: Query = { text: '旧全文', search: [
      { kind: 'pdftext', text: 'PDF内容' }, { kind: 'text', field: 'content', text: '文字内容' },
      { kind: 'tags', field: 'values', text: '收藏' }, { kind: 'pdf', field: 'author', text: '作者' },
      { kind: 'anchor', field: 'quote', text: '摘录原文' }
    ] }
    expect(searchTextFor(q, 'pdftext', 'content')).toBe('旧全文 PDF内容')
    expect(searchTextFor(q, 'text', 'content')).toBe('旧全文 文字内容')
    expect(searchTextFor({ search: [{ kind: 'note', text: '参考' }] }, 'body', 'content')).toBe('')
  })
})

describe('摘要', () => {
  it('Markdown 去掉记号再取那一句', async () => {
    const h = setup()
    const [x] = await h.host.api.ingest([{ type: 'text', text: '## 留白的力量\n\n画面里**空的地方**也是构图。\n\n- 留白给视线休息的位置\n\n| 概念 | 理解 |\n| --- | --- |\n| 留白 | [想象](https://x) |' }])
    const s = snippets(h.host.api.snippets([x], '留白'))[x]
    expect(s.text.startsWith('留白的力量 画面里空的地方也是构图。 留白给视线休息的位置')).toBe(true)
    expect(s.text).not.toMatch(/[#*|]/)
  })
})
