import { pluginSource } from '../helpers/plugin-sources'
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseEpub } from '@test-plugins/epub/lib/parse'
import { bookLink } from '@test-plugins/epub/lib/archive'
import { epubFixture } from '@test-plugins/epub/test/fixture'
import { positionOf, type Book } from '@test-plugins/epub/model'
import { packPlugin } from '../../scripts/plugins/pack'
import { bundledDescriptors, readDistribution } from '../../scripts/plugins/distribution'
import sharp from 'sharp'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { loadExternalCore, setBinding } from '../../src/core/external-plugins'
import { Host } from '../../src/core/host'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS, resolvePlugins } from '../../src/plugins/manifest'
import { tempDir } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
const temp = () => { const path = tempDir('rm-epub-'); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path }

it('EPUB 3 目录、中文路径、书内链接、文本偏移和图片；危险内容不能进入阅读树', () => {
  const parsed = parseEpub(epubFixture(), 'hash')
  expect(parsed.book).toMatchObject({ title: '山间来信', author: '林间', language: 'zh-CN' })
  expect(parsed.book.chapters).toHaveLength(3)
  expect(parsed.book.toc).toEqual(expect.arrayContaining([{ title: '一则脚注', chapter: 1, anchor: 'note', depth: 1 }]))
  expect(parsed.cover).toBe('书籍/images/cover.png')
  expect(parsed.documents[1].href).toBe('书籍/正文/第二 章.xhtml')
  expect(parsed.text.slice(parsed.book.chapters[1].start)).toMatch(/^风经过书页/)
  expect(JSON.stringify(parsed.documents)).not.toMatch(/onerror|javascript:|EPUB_INJECTED|display:none|iframe|example.com/)
  expect(JSON.stringify(parsed.documents)).toContain('危险链接保留文字')
  expect(JSON.stringify(parsed.documents)).toContain('"link":{"chapter":1,"anchor":"note"}')
  expect(parsed.images.size).toBe(1)
})
it('EPUB 2 使用 NCX 层级目录，无封面仍可阅读；书内位置只在同一原书恢复', () => {
  const p = parseEpub(epubFixture({ version: 2, cover: false }), 'hash')
  expect(p.book.toc[0].title).toBe('雨后的山路')
  expect(p.book.toc[2].depth).toBe(1)
  expect(p.cover).toBeUndefined()
  expect(positionOf(p.book, { sourceHash: 'hash', chapter: p.book.chapters[1].href, offset: 50 }).offset).toBe(50)
  expect(positionOf(p.book, { sourceHash: 'old', chapter: p.book.chapters[1].href, offset: 50 }).chapter).toBe(p.book.chapters[0].href)
})
it('拒绝越界包、固定版式、DRM 正文与自定义 XML 实体；普通章节相对路径可用', () => {
  expect(() => parseEpub(epubFixture({ extra: { '../escape.txt': 'escape' } }), 'h')).toThrow('越界')
  expect(() => parseEpub(epubFixture({ fixed: true }), 'h')).toThrow('固定版式')
  expect(() => parseEpub(epubFixture({ encrypted: true }), 'h')).toThrow('加密')
  expect(() => parseEpub(epubFixture({ extra: { 'META-INF/container.xml': '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><container>&x;</container>' } }), 'h')).toThrow('实体')
  expect(bookLink('book/a.xhtml', '../../escape')).toBeUndefined()
  expect(bookLink('book/a.xhtml', '%2Fetc/passwd')).toBeUndefined()
  expect(bookLink('book/a.xhtml', 'https://example.com/')).toBeUndefined()
  expect(bookLink('book/text/a.xhtml', '../image.png#题注')).toEqual({ path: 'book/image.png', anchor: '题注' })
})
it('独立打包并与全部附带插件启用；封面、批注裁图、搜索、进度、书签和停用保留', async () => {
  const root = temp(), source = temp(), userData = temp(), output = join(temp(), 'epub.rmplugin')
  cpSync(pluginSource("epub"), source, { recursive: true })
  await packPlugin(source, output)
  const manager = new PackageManager(userData, PLUGINS.map(p => p.id)), ref = manager.install(readFileSync(output))
  manager.grant(root, ref.hash)
  const lib = openLibrary(root)
  cleanups.push(() => { if (lib.db.open) lib.close() })
  // 附带的外部插件不在 corePlugins 中；必须实际安装并启用，才能覆盖共享产出的仲裁。
  const bundled = bundledDescriptors(resolve('.'))
  const catalog = bundled.map(({ dir, info }) => readDistribution(dir, info, 'bundled'))
  expect(bundled.some(p => p.info.id === 'annotate')).toBe(true)
  for (const { info } of bundled) {
    const path = join(temp(), 'bundled.rmplugin')
    await packPlugin(pluginSource(info.id), path)
    const installed = manager.install(readFileSync(path))
    manager.grant(root, installed.hash)
    setBinding(lib, { ...installed, enabled: true }, PLUGINS)
  }
  setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  let assembly = await loadExternalCore(lib, PLUGINS, corePlugins, manager.begin(root), catalog)
  const enabled = resolvePlugins([], assembly.manifest).enabled
  for (const id of ['epub', ...bundled.map(p => p.info.id)]) {
    expect(assembly.manifest.find(p => p.id === id)?.problem, id).toBeUndefined()
    expect(enabled.has(id), id).toBe(true)
  }
  let host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
  cleanups.push(() => host.close()); manager.ready(root)
  const input = join(temp(), '山间来信.epub'), bytes = epubFixture()
  writeFileSync(input, bytes)
  const [id] = await host.api.ingest([{ type: 'file', path: input }]); await host.scheduler.idle()
  let b = host.store.blocksOf(id)
  expect(host.store.get([id])[0].failures).toEqual({})
  expect(b.epub.data.title).toBe('山间来信')
  expect(b.thumb).toBeDefined()
  expect(b.still.data.path).toBe(b.epub.data.cover)
  const parsed=parseEpub(bytes,String(b.file.data.hash)), chapterData=parsed.documents[0]
  const quoteText='雨停之后',from=chapterData.text.indexOf(quoteText)
  const excerpt=host.api.create({anchor:{target:id,type:'内容摘录',quote:quoteText,locator:{provider:'epub.quote',version:1,data:{sourceHash:b.file.data.hash,chapter:chapterData.href,from,to:from+quoteText.length,prefix:chapterData.text.slice(Math.max(0,from-32),from),suffix:chapterData.text.slice(from+quoteText.length,from+quoteText.length+32)}}}}) as string
  await host.scheduler.idle();expect(host.store.blocksOf(excerpt).place.data.found).toBe(true)
  host.api.patch(excerpt,'anchor',{locator:{provider:'epub.quote',version:1,data:{sourceHash:'changed',chapter:chapterData.href}}})
  await host.scheduler.idle();expect(host.store.blocksOf(excerpt).place.data.found).toBe(false)
  host.api.undo();await host.scheduler.idle();expect(host.store.blocksOf(excerpt).place.data.found).toBe(true)

  const picture = join(temp(), '新图片.png')
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ff0000' } }).png().toFile(picture)
  const [image] = await host.api.ingest([{ type: 'file', path: picture }]); await host.scheduler.idle()
  const local = host.api.create({ anchor: { target: image, type: '图片区域', x: 0, y: 0, w: 0.25, h: 0.5, aspect: 100 / 150 } }) as string
  await host.scheduler.idle()
  const crop = host.store.blocksOf(local)
  expect(host.store.get([local])[0].failures).toEqual({})
  expect(crop.thumb).toBeDefined()
  const metadata = await sharp(join(root, String(crop.still.data.path))).metadata()
  expect([metadata.width, metadata.height]).toEqual([100, 150])
  expect((host.api.query({ search: [{ kind: 'epubtext', field: 'content', text: '晴岚密语' }] }) as { ids: string[] }).ids).toEqual([id])
  expect((await host.api.describeLibrary()).queries.map(q => q.name)).toEqual(expect.arrayContaining(['epub.chapters', 'epub.read_chapter']))
  const list = await host.api.executeQuery({ query: 'epub.chapters', args: { id }, limit: 2 })
  expect(list.result.items).toHaveLength(2)
  expect(list.result.nextCursor).toBeTypeOf('string')
  const chapter = await host.api.executeQuery({ query: 'epub.read_chapter', args: { id, chapter: 2, limit: 100 } })
  expect(chapter.result.text).toContain('晴岚密语')
  expect(chapter.result.nextOffset).toBe(100)
  const book = b.epub.data as unknown as Book
  const pos = { id, sourceHash: book.sourceHash, chapter: book.chapters[1].href, offset: 120 }
  host.api.run('epub', 'savePosition', pos)
  host.api.run('epub', 'addBookmark', { ...pos, title: '回到这里' })
  expect(host.store.blocksOf(id).epubbookmarks.data.items).toHaveLength(1)
  host.api.run('epub', 'addBookmark', { ...pos, title: '重复' })
  expect(host.store.blocksOf(id).epubbookmarks.data.items).toHaveLength(1)
  host.api.undo()
  expect(host.store.blocksOf(id).epubbookmarks).toBeUndefined()
  expect(host.store.blocksOf(id).epubreading.data.offset).toBe(120)
  host.api.redo()
  expect(() => host.api.run('epub', 'savePosition', { ...pos, sourceHash: 'wrong' })).toThrow('变化')
  const resources = [...b.epub.data.documents as string[], ...b.epub.data.assets as string[]]
  expect(resources.every(path => existsSync(join(root, path)))).toBe(true)
  const fileHash = createHash('sha256').update(readFileSync(host.lib.files.readable(String(b.file.data.path)))).digest('hex')
  expect(fileHash).toBe(book.sourceHash)
  host.close()
  const reopened = openLibrary(root)
  setBinding(reopened, { ...ref, enabled: false }, PLUGINS)
  assembly = await loadExternalCore(reopened, PLUGINS, corePlugins, manager.begin(root), catalog)
  host = new Host(root, assembly.plugins, () => {}, { library: reopened, manifest: assembly.manifest })
  b = host.store.blocksOf(id)
  expect(b.epubreading.data.offset).toBe(120)
  expect(b.epubbookmarks.data.items).toHaveLength(1)
  expect((await host.api.describeLibrary()).queries.some(q => q.name.startsWith('epub.'))).toBe(false)
  expect((await host.api.readContent({ id, kind: 'epubtext', field: 'content', limit: 100 })).text).toContain('雨后的山路')
  expect(readFileSync(host.lib.files.readable(String(b.file.data.path)))).toEqual(bytes)
}, 120000)
