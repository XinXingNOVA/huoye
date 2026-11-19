import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { planTransfer, uriList, webUrl, type TransferFacts } from '../../src/shared/transfer'
import { MAX_IMPORT_BYTES } from '../../src/shared/rpc'
import { downloadImage } from '../../src/main/download-image'
import { openHost } from '../helpers/helpers'

const facts = (overrides: Partial<TransferFacts> = {}): TransferFacts => ({ internal: '', files: [], text: '', html: '', htmlText: '', images: [], uris: [], ...overrides })
let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined; vi.unstubAllGlobals() })

describe('传输内容取舍', () => {
  it('内部引用优先且去重，损坏标记不误当外部文字收录', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(planTransfer(facts({ internal: JSON.stringify([id, id]), text: '卡片', files: [{ path: '/tmp/a', image: false }] }))).toEqual({ kind: 'internal', ids: [id] })
    for (const internal of ['{', '"not-array"', '[]', '["../file"]']) expect(() => planTransfer(facts({ internal }))).toThrow('素材拖动数据无效')
  })
  it('本地文件优先；无路径图片与同一张图的 HTML/网址只收一份', () => {
    expect(planTransfer(facts({ files: [{ path: '/tmp/a', image: true }], html: '<p>文件</p>', htmlText: '文件' })).kind).toBe('files')
    expect(planTransfer(facts({ files: [{ path: '', image: true }], html: '<img src="https://a.test/a.png">', images: ['https://a.test/a.png'], text: 'https://a.test/a.png' })).kind).toBe('files')
    expect(planTransfer(facts({ files: [{ path: '', image: false }], text: '文件' })).kind).toBe('files')
  })
  it('图文保留为整体；HTML-only 的正文不丢失，纯图片才下载', () => {
    const html = '<p>图注</p><img src="https://a.test/a.png">', images = ['https://a.test/a.png']
    expect(planTransfer(facts({ html, htmlText: '图注', images, files: [{ path: '', image: true }] }))).toEqual({ kind: 'html', text: '图注', html })
    expect(planTransfer(facts({ html: '<img>', images: [...images, ...images] }))).toEqual({ kind: 'images', urls: images })
  })
  it('图片地址与普通链接分开；URI 列表去注释，只接受网络地址；普通多行文字不误判', () => {
    expect(planTransfer(facts({ text: 'https://a.test/a.jpg?size=large' })).kind).toBe('images')
    expect(planTransfer(facts({ text: 'https://a.test/article\nhttps://b.test/' }))).toEqual({ kind: 'links', urls: ['https://a.test/article', 'https://b.test/'] })
    expect(planTransfer(facts({ text: 'https://a.test/\n我的备注' })).kind).toBe('text')
    expect(planTransfer(facts({ text: 'https://a.test/ 我的备注' })).kind).toBe('text')
    expect(uriList('# comment\r\nhttps://a.test/\nfile:///tmp/a\nhttps://a.test/')).toEqual(['https://a.test/'])
    for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'https://user:pass@a.test/', 'blob:https://a.test/a']) expect(webUrl(url)).toBeUndefined()
  })
})

describe('无路径数据进入已有文件管线', () => {
  it('保存原字节、图片加工与来源、同批/本地文件去重、撤销恢复、清理暂存', async () => {
    current = openHost()
    const { host: h, root } = current
    const bytes = await sharp({ create: { width: 21, height: 13, channels: 3, background: '#458ab2' } }).png().toBuffer()
    const input = { type: 'bytes' as const, bytes: new Uint8Array(bytes), name: '../网页图片.png', source: { url: 'https://example.com/article' } }
    const ids = await h.api.ingest([input, input])
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1])
    await h.scheduler.idle()
    const blocks = h.store.blocksOf(ids[0])
    expect(blocks.image.data).toMatchObject({ width: 21, height: 13 })
    expect(blocks.source.data.url).toBe(input.source.url)
    expect(readFileSync(h.lib.files.readable(String(blocks.file.data.path)))).toEqual(bytes)
    expect(readdirSync(join(h.lib.files.bindings!.default().space.root, 'cache', 'ingest'))).toEqual([])
    await h.api.undo(); expect(h.store.isTrashed(ids[0])).toBe(true)
    const path = join(root, 'same.png'); writeFileSync(path, bytes)
    expect(await h.api.ingest([{ type: 'file', path }])).toEqual([ids[0]])
    expect(h.store.isTrashed(ids[0])).toBe(false)
    expect(h.store.blocksOf(ids[0]).source.data.url).toBe(input.source.url)
  })
  it('零字节、超限数据和过长名称不留下身份；其他成功项仍可收录', async () => {
    current = openHost()
    const h = current.host
    const ids = await h.api.ingest([
      { type: 'bytes', bytes: new Uint8Array(), name: 'empty' },
      { type: 'bytes', bytes: new Uint8Array(MAX_IMPORT_BYTES + 1), name: 'large' },
      { type: 'bytes', bytes: new Uint8Array([1]), name: '字'.repeat(100) },
      { type: 'bytes', bytes: new TextEncoder().encode('保留文本文件'), name: 'text.txt' }
    ])
    expect(ids).toHaveLength(1)
    await h.scheduler.idle()
    expect(h.store.blocksOf(ids[0]).body.data.content).toBe('保留文本文件')
    expect(readdirSync(join(h.lib.files.bindings!.default().space.root, 'cache', 'ingest'))).toEqual([])
  })
})

describe('明确图片地址下载', () => {
  it('按实际字节识别扩展名，重定向后保留原文件且不带凭据', async () => {
    const bytes = await sharp({ create: { width: 7, height: 5, channels: 3, background: 'red' } }).png().toBuffer()
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/photo.jpg' } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
    vi.stubGlobal('fetch', request)
    const result = await downloadImage('https://example.com/image')
    expect(result.name).toBe('photo.png'); expect(Buffer.from(result.bytes)).toEqual(bytes)
    expect(request.mock.calls[1][0]).toBe('https://example.com/photo.jpg')
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' })
  })
  it('拒绝非网络协议、跨协议跳转、登录 HTML、过大响应和重定向循环', async () => {
    await expect(downloadImage('file:///tmp/private')).rejects.toThrow('HTTP')
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'file:///tmp/private' } }))
      .mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(MAX_IMPORT_BYTES + 1) } }))
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 302, headers: { location: '/loop' } })))
    vi.stubGlobal('fetch', request)
    await expect(downloadImage('https://example.com/a.png')).rejects.toThrow('重定向')
    await expect(downloadImage('https://example.com/a.png')).rejects.toThrow('不是可识别的图片')
    await expect(downloadImage('https://example.com/a.png')).rejects.toThrow('超过')
    await expect(downloadImage('https://example.com/a.png')).rejects.toThrow('重定向次数')
  })
  it('无 Content-Length 的响应仍受实际读取大小限制', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_IMPORT_BYTES + 1))))
    await expect(downloadImage('https://example.com/a.png')).rejects.toThrow('超过')
  })
})
