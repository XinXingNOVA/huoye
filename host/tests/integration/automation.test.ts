import { afterEach, describe, expect, it } from 'vitest'
import { openHost } from '../helpers/helpers'
import { callLocal, connectionError, listenLocal } from '../../src/plugins/mcp/local'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined })
const setup = () => (current = openHost()).host

describe('独立于界面的读取与操作服务', () => {
  it('按字段搜索与筛选共同生效，分页不漏项，变化后的旧游标明确失效', async () => {
    const h = setup()
    const template = await h.api.create({ template: { title: '资料', fields: [{ id: 'fsubject', title: '主题', type: 'text' }] } })
    const kind = `tpl:${template}`
    const a = await h.api.create({ text: { content: 'layout A' }, tags: { values: ['参考'] }, [kind]: { fsubject: '构图' } })
    const b = await h.api.create({ text: { content: 'layout B' }, tags: { values: ['参考'] }, [kind]: { fsubject: '构图' } })
    await h.api.create({ text: { content: 'layout C' }, [kind]: { fsubject: '无关' } })
    const query = { has: [kind], search: [{ kind, field: 'fsubject', text: '构图' }], where: [{ op: 'eq' as const, kind: 'tags', field: 'values', value: '参考' }] }
    const first = await h.api.searchPage({ query, limit: 1 })
    const second = await h.api.searchPage({ query, limit: 1, cursor: first.nextCursor! })
    expect([first.items[0].id, second.items[0].id].sort()).toEqual([a, b].sort())
    expect(second.nextCursor).toBeNull()
    expect((await h.api.facetPage({ kind, field: 'fsubject', query })).values).toEqual([{ value: '构图', count: 2 }])
    expect((await h.api.readItems({ ids: [a], kinds: [kind] })).items[0]).toMatchObject({ blocks: { [kind]: { data: { fsubject: '构图' } } } })
    expect(first.items[0].snippet?.field).toBe('fsubject')
    const defs = await h.api.describeLibrary()
    expect(defs.kinds.find(k => k.id === kind)?.fields.fsubject.search).toBe(true)
    expect(JSON.stringify(defs)).not.toContain(current!.root)
    expect(defs.operations.map(o => o.name).sort()).toEqual(['create_text', 'import_files', 'save_view', 'update_tags'])
    await h.api.trash([a])
    expect(() => h.api.searchPage({ query, cursor: first.nextCursor! })).toThrow(/STALE_CURSOR/)
    expect(() => h.api.searchPage({ limit: 1000 })).toThrow(/INVALID_INPUT/)
    expect(() => h.api.searchPage({ query: { search: [{ text: 'x', field: 'alone' }] } })).toThrow(/INVALID_INPUT/)
    expect(() => h.api.searchPage({ cursor: 'broken' })).toThrow(/CURSOR/)
    expect((await h.api.searchPage({ query: { scope: 'trash' } })).items.map(i => i.id)).toEqual([a])
  })

  it('正文、PDF 页文字和 JSON 都有界读取，续读检查版本，元数据不塞入整篇正文', async () => {
    const h = setup()
    const a = await h.api.create({ text: { content: '第一页😀'.repeat(2000) }, tags: { values: ['参考'] } })
    h.store.put(a, 'pdftext', { content: 'first page\nsecond page', pages: [0, 11], source: 1 })
    const info = await h.api.readItem({ id: a })
    expect(info.fields.find(f => f.kind === 'text')?.truncated).toBe(true)
    expect(JSON.stringify(info).length).toBeLessThan(3000)
    const page = await h.api.readContent({ id: a, kind: 'pdftext', field: 'content', page: 2 })
    expect(page).toMatchObject({ page: 2, pages: 2, text: 'second page', next: null })
    expect(() => h.api.readContent({ id: a, kind: 'pdftext', field: 'content', page: 3 })).toThrow(/INVALID_PAGE/)
    const first = await h.api.readContent({ id: a, kind: 'text', field: 'content', limit: 4 })
    const second = await h.api.readContent(first.next!)
    expect(first.text + second.text).toBe('第一页😀第一页😀')
    await h.api.patch(a, 'text', { content: '已改写' })
    expect(() => h.api.readContent(first.next!)).toThrow(/CONTENT_CHANGED/)
    expect((await h.api.readContent({ id: a, kind: 'tags', field: 'values' })).text).toBe('["参考"]')
    expect(() => h.api.readContent({ id: a, kind: 'text', field: 'content', offset: 1000 })).toThrow(/INVALID_OFFSET/)
    expect(() => h.api.readContent({ id: a, kind: 'body', field: 'content' })).toThrow(/CONTENT_UNAVAILABLE/)
    const partial = await h.api.readItem({ id: a, limit: 1 })
    const next = await h.api.readItem({ id: a, limit: 1, offset: partial.nextOffset! })
    expect(next.fields[0]).not.toEqual(partial.fields[0])
    expect(() => h.api.readItem({ id: 'gone' })).toThrow(/NOT_FOUND/)
  })

  it('批量投影按输入位置续页，区分缺项、回收和大块；持久块与派生块都保留版本', async () => {
    const h = setup(), id = await h.api.create({ text: { content: '稿'.repeat(5000) }, tags: { values: ['参考'] } })
    h.store.put(id, 'image', { animated: false })
    const other = await h.api.create({ text: { content: 'a'.repeat(7000) } })
    await h.api.trash([other])
    const input = { ids: [id, '已清除', ...Array<string>(65).fill(other)], kinds: ['text','image'] }
    const first = await h.api.readItems(input)
    expect(first.items[0]).toEqual({ id, state: 'active', blocks: {
      text: { omitted: true, bytes: Buffer.byteLength(JSON.stringify({ content: '稿'.repeat(5000) })), seq: h.store.blocksOf(id).text.seq, ver: 1 },
      image: h.store.blocksOf(id).image
    } })
    expect(first.items[1]).toEqual({ id: '已清除', state: 'missing' })
    expect(first.items[2]).toMatchObject({ state: 'trashed', blocks: { text: { data: { content: 'a'.repeat(7000) } } } })
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024)
    expect(first.nextOffset).toBe(first.items.length)
    const rest = await h.api.readItems({ ...input, offset: first.nextOffset! })
    expect(rest.nextOffset).toBeNull()
    expect([...first.items,...rest.items].map(i => i.id)).toEqual(input.ids)
    expect(() => h.api.readItems({ ids: [id], kinds: ['拼错的类型'] })).toThrow('INVALID_INPUT')
    expect(() => h.api.readItems({ ...input, offset: input.ids.length + 1 })).toThrow('INVALID_OFFSET')
  })

  it('分面统计全范围的有值身份、缺值和去重列表，保留布尔类型与超长值边界，变化后拒绝旧页', async () => {
    const h = setup(), big = '长'.repeat(1000)
    const a = await h.api.create({ text: { content: 'a' }, tags: { values: ['甲','甲','乙',big] } })
    const b = await h.api.create({ text: { content: 'b' }, tags: { values: ['甲'] } })
    await h.api.create({ text: { content: 'c' }, tags: { values: [] } })
    h.store.put(a, 'image', { animated: false }); h.store.put(b, 'image', { animated: true })
    const tags = { kind: 'tags', field: 'values', limit: 1 }
    const first = await h.api.facetPage(tags)
    expect(first).toMatchObject({ matchedItems: 3, withValue: 2, missingItems: 1, values: [{ value: '甲', count: 2 }] })
    const rest = await h.api.facetPage({ ...tags, limit: 10, cursor: first.nextCursor! })
    expect(rest.values).toEqual([{ value: '乙', count: 1 }, { value: null, preview: big.slice(0,160), bytes: Buffer.byteLength(big), sampleId: a, count: 1 }])
    expect(rest.nextCursor).toBeNull()
    expect((await h.api.facetPage({ kind: 'image', field: 'animated' })).values).toEqual([{ value: false, count: 1 }, { value: true, count: 1 }])
    expect(() => h.api.facetPage({ ...tags, query: { ids: [a] }, cursor: first.nextCursor! })).toThrow('STALE_CURSOR')
    expect(() => h.api.facetPage({ kind: 'text', field: 'content' })).toThrow('INVALID_INPUT')
    await h.api.trash([b])
    expect(() => h.api.facetPage({ ...tags, cursor: first.nextCursor! })).toThrow('STALE_CURSOR')
    expect(await h.api.facetPage({ ...tags, query: { scope: 'trash' } })).toMatchObject({ matchedItems: 1, values: [{ value: '甲', count: 1 }] })
    expect(await h.api.facetPage({ ...tags, query: { ids: ['不存在'] } })).toEqual({ matchedItems: 0, withValue: 0, missingItems: 0, values: [], nextCursor: null })
  })

  it('批量标签按最新数据做增量修改；失败全回滚，一次撤销；UI 与 AI 共用命令', async () => {
    const h = setup()
    const a = await h.api.create({ text: { content: 'A' }, tags: { values: ['已有'] } })
    const b = await h.api.create({ text: { content: 'B' } })
    const run = (requestId: string, ids: string[], add: string[], remove: string[] = []) =>
      h.api.executeOperation({ operation: 'update_tags', requestId, args: { ids, add, remove } })
    await h.api.run('tags', 'update', { ids: [a], add: ['界面先加'] })
    const result = await run('request-one', [a, b, b], ['AI 标签', 'AI 标签'])
    expect(result).toMatchObject({ replayed: false, result: { changed: [a, b] } })
    const history = await h.api.listHistory({ requestId: 'request-one' })
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({ source: 'external', plugin: 'tags', operation: 'update_tags', requestId: 'request-one', affected: 2 })
    expect(h.store.blocksOf(a).tags.data.values).toEqual(['已有', '界面先加', 'AI 标签'])
    expect(await h.api.undo()).toContain('外部 · 更新标签（2 项）')
    expect(h.store.blocksOf(a).tags.data.values).toEqual(['已有', '界面先加'])
    expect(h.store.blocksOf(b).tags).toBeUndefined()
    const retry = await run('request-one', [a, b, b], ['AI 标签', 'AI 标签'])
    expect(retry.replayed).toBe(true)
    expect((await h.api.listHistory({ requestId: 'request-one' })).entries).toEqual([{ ...history.entries[0], state: 'undone' }])
    expect(h.store.blocksOf(b).tags).toBeUndefined()
    await h.api.redo()
    expect(h.store.blocksOf(b).tags.data.values).toEqual(['AI 标签'])
    const before = h.store.blocksOf(a), beforeHistory = await h.api.listHistory()
    h.lib.db.exec("CREATE TEMP TRIGGER history_receipt_failure BEFORE INSERT ON operation_receipt BEGIN SELECT RAISE(ABORT,'receipt failure'); END")
    expect(() => run('request-fail-receipt', [a], ['不应保存'])).toThrow('receipt failure')
    h.lib.db.exec('DROP TRIGGER history_receipt_failure')
    expect(await h.api.listHistory()).toEqual(beforeHistory)
    expect(() => run('request-bad', [a, 'missing'], ['wrong'])).toThrow(/NOT_FOUND/)
    expect(h.store.blocksOf(a)).toEqual(before)
    expect(await h.api.listHistory()).toEqual(beforeHistory)
    expect(() => run('request-one', [a], ['different'])).toThrow(/REQUEST_ID_CONFLICT/)
    expect(() => run('request-conflict', [a], ['x'], ['x'])).toThrow(/INVALID_INPUT/)
    expect(() => h.api.executeOperation({ operation: 'purge', requestId: 'no-purge', args: { ids: [a] } })).toThrow(/UNAVAILABLE_OPERATION/)
    await h.api.trash([b])
    expect(() => run('request-trash', [a, b], ['wrong'])).toThrow(/NOT_FOUND/)
  })

  it('回执随库重启保留；停用插件立即从可调用操作中消失，数据仍可读取', async () => {
    let h = setup()
    const a = await h.api.create({ text: { content: 'A' } })
    const input = { operation: 'update_tags', requestId: 'stable-request', args: { ids: [a], add: ['参考'] } }
    const first = await h.api.executeOperation(input)
    const root = current!.root
    h.close(); current = openHost(undefined, undefined, root); h = current.host
    expect(await h.api.executeOperation(input)).toEqual({ ...first, replayed: true })
    await h.api.setPlugins(['tags'])
    h.close(); current = openHost(undefined, undefined, root); h = current.host
    expect((await h.api.describeLibrary()).operations.map(o => o.name)).not.toContain('update_tags')
    expect(() => h.api.executeOperation(input)).toThrow(/UNAVAILABLE_OPERATION/)
    expect((await h.api.readContent({ id: a, kind: 'tags', field: 'values' })).text).toContain('参考')
  })
})

describe('本机桥的边界', () => {
  it('连接权限被拒绝与应用离线分别诊断，不把所有错误都当成离线', () => {
    for (const code of ['EPERM', 'EACCES']) expect(connectionError({ code, name: 'Error', message: 'denied' })).toContain('[CONNECTION_DENIED]')
    for (const code of ['ENOENT', 'ECONNREFUSED']) expect(connectionError({ code, name: 'Error', message: 'offline' })).toContain('[LIBRARY_OFFLINE]')
    expect(connectionError({ code: 'EMFILE', name: 'Error', message: 'too many files' })).toContain('[CONNECTION_FAILED]')
  })
  it('传输结果和业务错误，拒绝超大请求', async () => {
    const dir = mkdtempSync('/tmp/rm-bridge-')
    const connection = { libraryId: 'application', token: 'a'.repeat(43), endpoint: join(dir, 's'), mode: 'read' as const }
    const bridge = await listenLocal(connection.endpoint, async r => {
      if (r.name === 'write') throw new Error('[READ_ONLY] 只读')
      return { ok: true }
    })
    try {
      expect(await callLocal(connection, 'read')).toEqual({ ok: true })
      await expect(callLocal(connection, 'write')).rejects.toThrow(/READ_ONLY/)
      await expect(callLocal(connection, 'read', { giant: 'x'.repeat(300000) })).rejects.toThrow(/INVALID_INPUT|OFFLINE/)
    } finally { bridge.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
