import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openHost } from '../helpers/helpers'
import type { IngestResult } from '../../src/plugin-api/operations'
import type { CorePlugin } from '../../src/core/plugin'
import { filePlugin } from '../../src/plugins/file/core'

let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined })
const setup = () => (current = openHost()).host

describe('外部创建与收录', () => {
  it('文字、标签、来源一次创建，搜索可见，重试与撤销互不覆盖', async () => {
    const h = setup()
    const request = { operation: 'create_text', requestId: 'create-text-once', args: {
      content: '# AI 保存\n这是一次书籍摘要', tags: ['参考', ' 参考 ', '阅读'], source: { url: 'https://www.example.com/book', title: '原文' }
    } }
    const first = await h.api.executeOperation(request)
    const id = (first.result as { id: string }).id
    expect(h.store.blocksOf(id).tags.data.values).toEqual(['参考', '阅读'])
    expect(h.store.blocksOf(id).source.data).toEqual({ url: 'https://www.example.com/book', title: '原文', site: 'example.com' })
    expect((await h.api.searchPage({ query: { search: [{ kind: 'text', text: '摘要' }] } })).items.map(i => i.id)).toEqual([id])
    expect(await h.api.executeOperation(request)).toEqual({ ...first, replayed: true })
    expect(await h.api.undo()).toBe('外部 · 新建文字')
    expect(h.store.isTrashed(id)).toBe(true)
    expect((await h.api.readContent({ id, kind: 'text', field: 'content' })).text).toContain('书籍摘要')
    expect((await h.api.executeOperation(request)).replayed).toBe(true)
    expect(h.store.isTrashed(id)).toBe(true)
    await h.api.redo()
    expect(h.store.isTrashed(id)).toBe(false)
    expect(() => h.api.executeOperation({ ...request, args: { content: '更改' } })).toThrow(/REQUEST_ID_CONFLICT/)
  })

  it('空文字、无效来源、超限与未知字段拒绝；缺少可选插件不静默丢数据', async () => {
    let h = setup()
    for (const args of [{ content: ' ' }, { content: 'a'.repeat(32001) }, { content: 'x', source: { url: 'file:///tmp/private' } }, { content: 'x', extra: true }]) {
      expect(() => h.api.executeOperation({ operation: 'create_text', requestId: 'invalid-create', args })).toThrow(/INVALID_INPUT/)
    }
    expect((await h.api.query({})).ids.length).toBe(0)
    await h.api.setPlugins(['tags', 'source'])
    const root = current!.root
    h.close(); current = openHost(undefined, undefined, root); h = current.host
    for (const args of [{ content: 'x', tags: ['参考'] }, { content: 'x', source: { url: 'https://example.com' } }]) {
      expect(() => h.api.executeOperation({ operation: 'create_text', requestId: 'missing-optional', args })).toThrow(/UNAVAILABLE_PLUGIN/)
    }
    expect((await h.api.query({})).ids.length).toBe(0)
    expect((await h.api.executeOperation({ operation: 'create_text', requestId: 'plain-text-only', args: { content: '独立文字' } })).replayed).toBe(false)
    await h.api.setPlugins(['text'])
    h.close(); current = openHost(undefined, undefined, root); h = current.host
    expect(() => h.api.executeOperation({ operation: 'create_text', requestId: 'text-disabled', args: { content: 'x' } })).toThrow(/UNAVAILABLE_OPERATION/)
  })

  it('并发重复请求只收录一次，逐项错误、后台正文、批次撤销和持久回执', async () => {
    let h = setup()
    const root = current!.root, file = join(root, 'input.txt')
    writeFileSync(file, 'mcp ingest needle 新素材')
    const request = { operation: 'import_files', requestId: 'import-stable-id', args: { paths: [file, file, root, join(root, 'missing.txt')] } }
    const [first, replay] = await Promise.all([h.api.executeOperation(request), h.api.executeOperation(request)])
    expect(replay).toEqual({ ...first, replayed: true })
    const result = first.result as IngestResult
    expect(result.items.map(i => [i.index, i.outcome])).toEqual([[0, 'created'], [1, 'existing']])
    expect(result.items[0].id).toBe(result.items[1].id)
    expect(result.errors.map(e => e.index)).toEqual([2, 3])
    expect(result.processing).toBe('not_waited')
    const id = result.items[0].id
    expect(readFileSync(h.lib.files.readable(String(h.store.blocksOf(id).file.data.path)))).toEqual(readFileSync(file))
    expect((await h.api.readItem({ id })).processing).toBe('pending')
    await h.scheduler.idle()
    expect((await h.api.readItem({ id })).processing).toBe('idle')
    expect((await h.api.readContent({ id, kind: 'body', field: 'content' })).text).toContain('needle')
    expect(await h.api.undo()).toContain('外部 · 收录')
    expect(h.store.isTrashed(id)).toBe(true)
    expect(h.store.blocksOf(id).file.data.path).toBeTruthy()
    expect(h.store.findByField('file', 'hash', String(h.store.blocksOf(id).file.data.hash))).toBe(id)
    expect((await h.api.executeOperation(request)).replayed).toBe(true)
    expect(h.store.isTrashed(id)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('needle')
    h.close(); current = openHost(undefined, undefined, root); h = current.host
    expect(await h.api.executeOperation(request)).toEqual({ ...first, replayed: true })
    expect(h.store.isTrashed(id)).toBe(true)
  })

  it('已有文件只复用；回收站恢复可以撤销；不同请求也按内容去重', async () => {
    const h = setup(), root = current!.root, path = join(root, 'original.txt'), second = join(root, 'renamed.md')
    writeFileSync(path, '已有文件'); writeFileSync(second, '已有文件')
    const [id] = await h.api.ingest([{ type: 'file', path }])
    await h.api.put(id, 'note', { text: '已有笔记' })
    const input = { operation: 'import_files', requestId: 'dedup-existing', args: { paths: [second] } }
    expect(((await h.api.executeOperation(input)).result as IngestResult).items).toEqual([{ index: 0, id, outcome: 'existing' }])
    expect(await h.api.undo()).toContain('笔记') // 复用不制造空撤销步骤
    expect(h.store.isTrashed(id)).toBe(false)
    await h.api.trash([id])
    expect(((await h.api.executeOperation({ ...input, requestId: 'restore-existing' })).result as IngestResult).items[0].outcome).toBe('restored')
    expect(h.store.isTrashed(id)).toBe(false)
    await h.api.undo()
    expect(h.store.isTrashed(id)).toBe(true)
    expect((await h.api.executeOperation({ ...input, requestId: 'restore-existing' })).replayed).toBe(true)
    expect(h.store.isTrashed(id)).toBe(true)
  })

  it('全失败留回执，修正后新请求才能导入；相对路径和超大批次在接入前拒绝', async () => {
    const h = setup(), path = join(current!.root, 'later.txt')
    const request = { operation: 'import_files', requestId: 'failed-import-id', args: { paths: [path] } }
    const failed = await h.api.executeOperation(request)
    expect((failed.result as IngestResult).items).toEqual([])
    writeFileSync(path, '之后出现')
    expect(await h.api.executeOperation(request)).toEqual({ ...failed, replayed: true })
    expect((await h.api.query({})).ids.length).toBe(0)
    expect(((await h.api.executeOperation({ ...request, requestId: 'fixed-import-id' })).result as IngestResult).items).toHaveLength(1)
    for (const paths of [[], ['relative.txt'], Array(21).fill(path)]) {
      expect(() => h.api.executeOperation({ ...request, args: { paths } })).toThrow(/INVALID_INPUT/)
    }
  })

  it('异步准备不暴露空身份；关库不提交；重启原请求可以安全重试', async () => {
    let release!: () => void, started!: () => void
    const began = new Promise<void>(r => { started = r })
    const gate = new Promise<void>(r => { release = r })
    const slow: CorePlugin = { ...filePlugin, recognizers: [{ ...filePlugin.recognizers![0], async ingest(ctx, input) {
      const id = await filePlugin.recognizers![0].ingest(ctx, input)
      started(); await gate; return id
    } }] }
    current = openHost([slow]); const h = current.host, root = current.root, path = join(root, 'file.txt')
    writeFileSync(path, 'slow')
    const request = { operation: 'import_files', requestId: 'interrupted-import', args: { paths: [path] } }
    const pending = h.api.executeOperation(request)
    await began
    expect((await h.api.query({})).ids.length).toBe(0)
    expect(() => h.api.executeOperation({ ...request, args: { paths: [root] } })).toThrow(/REQUEST_ID_CONFLICT/)
    h.close(); release()
    await expect(pending).rejects.toThrow(/LIBRARY_CLOSED/)
    current = openHost(undefined, undefined, root)
    expect((await current.host.api.executeOperation(request)).replayed).toBe(false)
    expect((await current.host.api.query({})).ids.length).toBe(1)
    expect(readdirSync(join(current!.host.lib.files.bindings!.default().space.root, 'cache', 'ingest'))).toEqual([])
  })

  it('收录失败回滚素材和回执，已保存文件留在空间等待重试', async () => {
    const broken: CorePlugin = { id: 'broken', version: 1, afterIngest() { throw new Error('commit failure') } }
    current = openHost([filePlugin, broken]); const h = current.host, path = join(current.root, 'file.txt')
    writeFileSync(path, 'rollback')
    await expect(h.api.executeOperation({ operation: 'import_files', requestId: 'rollback-import', args: { paths: [path] } })).rejects.toThrow('commit failure')
    expect((await h.api.query({})).ids.length).toBe(0)
    expect(h.lib.db.prepare('SELECT count(*) FROM operation_receipt').pluck().get()).toBe(0)
    expect(h.lib.files.bindings!.default().space.db.prepare("SELECT count(*) FROM files WHERE state='available'").pluck().get()).toBe(1)
    expect(h.lib.db.prepare('SELECT count(*) FROM ingest_pending').pluck().get()).toBe(1)
    expect(await h.api.undo()).toBeNull()
  })
})
