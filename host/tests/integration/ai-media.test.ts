import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, rmSync, symlinkSync } from 'node:fs'
import sharp from 'sharp'
import { openHost, tempDir } from '../helpers/helpers'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { ApplicationAccess, type ApplicationLibrary } from '../../src/main/application-access'
import type { ExternalCaller } from '../../src/plugin-api/service'
import { toolResult } from '../../src/plugins/mcp/result'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup() {
  const h = openHost(corePlugins, { manifest: PLUGINS }), { host, root } = h
  let active = true
  cleanups.push(async () => { if (active) { await host.scheduler.idle(); h.cleanup() } else rmSync(root, { recursive: true, force: true }) })
  const lib: ApplicationLibrary = { id: host.lib.id, root, active: () => active,
    call: (async (method, ...args) => (host.api[method] as (...args: unknown[]) => unknown)(...args)) as ExternalCaller }
  const access = new ApplicationAccess({ userData: join(root, 'user'), active: () => true, libraries: () => active ? [lib] : [], open: async () => lib })
  access.register(lib)
  const key = access.settings().libraries[0].key
  const mode = (mode: 'off' | 'read' | 'organize') => access.settings({ enabled: true, grant: { key, mode } })
  mode('organize')
  const input = async (name: string, color: string, orientation?: number) => {
    const path = join(root, name)
    let pipeline = sharp({ create: { width: 200, height: 100, channels: 3, background: color } })
    if (orientation) pipeline = pipeline.withMetadata({ orientation })
    await pipeline.jpeg().toFile(path)
    return { path }
  }
  return { ...h, lib, access, mode, input, close: () => { active = false; host.close() } }
}
const pixels = (base64: string) => sharp(Buffer.from(base64, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })

it('单图转正与限尺寸；拼版固定编号和失败位置，MCP 图像不重复塞进 JSON', async () => {
  const f = setup(), files = [await f.input('red.jpg', '#ff0000', 6), await f.input('blue.jpg', '#0000ff')]
  const imported = await f.access.importFiles(f.lib.id, { requestId: 'preview-fixtures', files, waitMs: 2000 })
  expect(imported.processingObservation).toMatchObject({ state: 'observed', timedOut: false })
  const [red, blue] = imported.items.map(item => item.id)
  f.mode('read')
  const single = await f.access.call(f.lib.id, 'readPreview', { ids: [red] })
  expect(single.image).toMatchObject({ width: 100, height: 200, mimeType: 'image/jpeg' })
  const singleMetadata = await sharp(Buffer.from(single.image!.data, 'base64')).metadata()
  expect(singleMetadata.format).toBe('jpeg'); expect(singleMetadata.orientation).toBeUndefined(); expect(singleMetadata.exif).toBeUndefined()
  const grid = await f.access.call(f.lib.id, 'readPreview', { ids: [blue, 'missing', red], mode: 'grid', maxSide: 960 })
  expect(grid.items.map(i => [i.index, i.id, i.state])).toEqual([[1, blue, 'ready'], [2, 'missing', 'missing'], [3, red, 'ready']])
  expect(grid.image).toMatchObject({ width: 960, height: 320 })
  const p = await pixels(grid.image!.data)
  const at = (x: number, y: number) => [...p.data.subarray((y * p.info.width + x) * 3, (y * p.info.width + x) * 3 + 3)]
  expect(at(160, 180)[2]).toBeGreaterThan(240)
  expect(at(800, 180)[0]).toBeGreaterThan(240)
  const result = toolResult('read_preview', grid)
  expect(result.content.filter(c => c.type === 'image')).toHaveLength(1)
  expect(JSON.stringify(result.structuredContent)).not.toContain(grid.image!.data)
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.not.stringContaining(grid.image!.data) })
  expect(toolResult('execute_query', { image: grid.image }).content.every(c => c.type === 'text')).toBe(true)
  f.mode('off')
  await expect(f.access.call(f.lib.id, 'readPreview', { ids: [red] })).rejects.toThrow('ACCESS_DENIED')
})

it('输入凭据、异步读取变化和重新加工均阻止发布旧图；回收及无图素材逐项报告', async () => {
  const f = setup(), files = [await f.input('first.jpg', 'red')]
  const imported = await f.access.importFiles(f.lib.id, { requestId: 'version-fixture', files, waitMs: 2000 })
  const id = imported.items[0].id, original = await f.host.api.readPreview({ ids: [id] })
  await f.host.api.put(id, 'text', { content: '另加说明' })
  const changed = await f.host.api.readPreview({ ids: [id], expectedRevisions: { [id]: original.items[0].revision } })
  expect(changed.items[0].state).toBe('changed'); expect(changed.image).toBeUndefined()
  const readable = f.host.lib.files.readable.bind(f.host.lib.files)
  vi.spyOn(f.host.lib.files, 'readable').mockImplementationOnce(path => {
    queueMicrotask(() => { void f.host.api.put(id, 'text', { content: '读取时变化' }) })
    return readable(path)
  })
  const racing = await f.host.api.readPreview({ ids: [id] })
  expect(racing.items[0].state).toBe('changed'); expect(racing.image).toBeUndefined()
  f.host.scheduler.regenerate([id])
  const pending = await f.host.api.readPreview({ ids: [id] })
  expect(pending.items[0].state).toBe('pending'); expect(pending.image).toBeUndefined()
  await f.host.scheduler.idle()
  const text = await f.host.api.create({ text: { content: '没有图片' } })
  await f.host.api.trash([id])
  const unavailable = await f.host.api.readPreview({ ids: [id, text], mode: 'grid' })
  expect(unavailable.items.map(i => i.state)).toEqual(['trashed', 'unsupported']); expect(unavailable.image).toBeUndefined()
})

it('原件缺失可读当前缩略图；缓存越界链接不可读，批次上限与未知路径参数拒绝', async () => {
  const f = setup(), file = await f.input('original.jpg', 'red')
  const imported = await f.access.importFiles(f.lib.id, { requestId: 'offline-fixture', files: [file], waitMs: 2000 })
  const id = imported.items[0].id, blocks = f.host.store.blocksOf(id)
  const source = f.host.lib.files.readable(String(blocks.file.data.path)), thumb = f.host.lib.files.readable(String(blocks.thumb.data.path))
  rmSync(source)
  const cached = await f.host.api.readPreview({ ids: [id] })
  expect(cached.items[0]).toMatchObject({ state: 'ready', source: { kind: 'thumb' }, original: { state: expect.not.stringMatching(/^available$/) } })
  const outside = tempDir('rm-preview-outside-'); cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
  await sharp(readFileSync(file.path)).toFile(join(outside, 'secret.jpg'))
  rmSync(thumb); symlinkSync(join(outside, 'secret.jpg'), thumb)
  expect((await f.host.api.readPreview({ ids: [id] })).image).toBeUndefined()
  await expect(f.host.api.readPreview({ ids: Array(13).fill(id), mode: 'grid' })).rejects.toThrow()
  await expect(f.host.api.readPreview({ ids: [id], path: '/etc/passwd' } as any)).rejects.toThrow()
})

it('预览读取中撤权、关库不会发布字节；同时请求受并发限制', async () => {
  const f = setup(), file = await f.input('active.jpg', 'blue')
  const imported = await f.access.importFiles(f.lib.id, { requestId: 'closing-fixture', files: [file], waitMs: 2000 })
  const ids = [imported.items[0].id]
  const first = f.access.call(f.lib.id, 'readPreview', { ids })
  await expect(f.host.api.readPreview({ ids })).rejects.toThrow('PREVIEW_BUSY')
  f.mode('off')
  await expect(first).rejects.toThrow('ACCESS_DENIED')
  const closing = f.host.api.readPreview({ ids })
  f.close()
  await expect(closing).rejects.toThrow('LIBRARY_OFFLINE')
})

it('导入观察独立于持久签名和回执，调预算续查不重复写；仅保存与观察失败均保留结果', async () => {
  const f = setup(), files = [await f.input('import.jpg', 'red')], input = { requestId: 'inline-import', files }
  const first = await f.access.importFiles(f.lib.id, input)
  const next = await f.access.importFiles(f.lib.id, { ...input, waitMs: 2000, processingKinds: ['thumb', 'image'] })
  expect(next.processingObservation).toMatchObject({ state: 'observed', timedOut: false })
  const { processingObservation: _, ...receipt } = next
  expect(receipt).toEqual(first)
  const stored = f.host.lib.db.prepare('SELECT result FROM main.operation_receipt WHERE request_id=?').pluck().get(input.requestId) as string
  expect(JSON.parse(stored)).toEqual(first)
  const saved = await f.access.importFiles(f.lib.id, { ...input, requestId: 'save-only-image', collect: false, waitMs: 2000 })
  expect(saved.items).toEqual([]); expect(saved.processingObservation).toEqual({ state: 'not-collected' })
  const failed = await f.access.importFiles(f.lib.id, { requestId: 'no-imported-items', files: [{ path: join(f.root, 'no.jpg') }], waitMs: 2000 })
  expect(failed.errors).toHaveLength(1); expect(failed.processingObservation).toEqual({ state: 'empty' })
  vi.spyOn(f.access, 'processing').mockRejectedValueOnce(new Error('[TIMEOUT] 加工观察超时'))
  expect(await f.access.importFiles(f.lib.id, { ...input, waitMs: 100 })).toMatchObject({ items: first.items, processingObservation: { state: 'unavailable', reason: expect.stringContaining('TIMEOUT') } })
  vi.spyOn(f.access, 'processing').mockImplementationOnce(async () => { f.mode('off'); throw new Error('撤权') })
  await expect(f.access.importFiles(f.lib.id, { ...input, waitMs: 100 })).rejects.toThrow('ACCESS_DENIED')
})
