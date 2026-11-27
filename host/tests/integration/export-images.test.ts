import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import type { CorePlugin, ExportContext } from '../../src/plugin-api/core/contracts'
import { packageInfo, packageManifestSchema } from '../../src/shared/external-plugins'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { openHost, tempDir } from '../helpers/helpers'

it('源码态真实 Worker 读取原图用于导出，缩略图租约按尺寸独立，导出只允许当前项的引用', async () => {
  const dir = tempDir()
  const cap = 'pages/archive.page@1'
  const contract = { id: cap, source: 'file', input: {}, output: {}, artifact: 'image', interactive: true } as const
  const pack = { directory: dir, hash: 'c'.repeat(64), manifest: packageManifestSchema.parse({
    formatVersion: 1, apiVersion: 1, id: 'engine', title: 'Engine', description: '', author: 'test', version: '1.0.0',
    entries: { provider: 'provider.mjs' }, capabilities: { version: 2, provides: [cap], contracts: [contract],
      implementations: [{ id: cap, execution: 'local' }] }
  }) }
  writeFileSync(join(dir, 'provider.mjs'), `import { readFile } from 'node:fs/promises'
    export const plugin = { id: 'engine', handlers: { '${cap}': (_, ctx) => readFile(ctx.sourcePath) } }`)
  const pageKind = 'pages.favorite'
  let captured: ExportContext | undefined
  let unrelated = ''
  const plugin: CorePlugin = { id: 'pages', version: 1, blocks: [{ id: pageKind, plugin: 'pages', title: 'Page',
    content: true, rebuildable: false, version: 1, fields: { target: { type: 'ref', ref: 'link', title: 'Book' } } }],
    exporters: [{ priority: 1, match: b => !!b[pageKind], place: () => ({ folder: 'pages', name: 'page.jpg' }),
      async write(ctx, _id, b, dest) {
        captured = ctx
        const id = String(b[pageKind].data.target), file = ctx.blocksOf(id).file
        expect(() => ctx.blocksOf(unrelated)).toThrow('CAPABILITY_SOURCE_UNAVAILABLE')
        await expect(ctx.capabilities.image(cap, { id: unrelated, fileSeq: file.seq, params: {} })).rejects.toThrow('CAPABILITY_SOURCE_UNAVAILABLE')
        await expect(ctx.capabilities.image(cap, { id, fileSeq: file.seq + 1, params: {} })).rejects.toThrow('CAPABILITY_SOURCE_CHANGED')
        const image = await ctx.capabilities.image(cap, { id, fileSeq: file.seq, params: {} })
        expect(image).toMatchObject({ width: 800, height: 600, mime: 'image/jpeg' })
        writeFileSync(dest, image.bytes)
      } }]
  }
  const client = { id: plugin.id, title: 'Pages', description: '', capabilities: { version: 2 as const, consumes: [cap], contracts: [contract] } }
  const h = openHost([...legacyCorePlugins, plugin], { manifest: [...legacyManifest, client, packageInfo(pack)],
    providerAssembly: { packages: [pack] }, imageDirectory: dir })
  try {
    const original = await sharp({ create: { width: 800, height: 600, channels: 3, background: 'green' } }).jpeg().toBuffer()
    const path = join(dir, 'original.jpg')
    writeFileSync(path, original)
    const [id] = await h.host.api.ingest([{ type: 'file', path }])
    unrelated = (await h.host.api.ingest([{ type: 'text', text: 'other' }]))[0]
    const favorite = await h.host.api.create({ [pageKind]: { target: id } })
    const output = await h.host.api.exportRun({ ids: [favorite], titles: {}, parent: dir, name: 'out' })
    expect(output.failed).toEqual([])
    expect(readFileSync(join(dir, 'out/pages/page.jpg'))).toEqual(original)
    expect(() => captured!.blocksOf(id)).toThrow('CAPABILITY_EXPIRED')

    const input = { id, fileSeq: h.host.store.blocksOf(id).file.seq, params: {} }
    const full = { lease: randomUUID(), capability: cap, plugin: 'pages', priority: 'display', input } as const
    const small = { ...full, lease: randomUUID(), maxEdge: 96 }
    const results = await Promise.all([h.host.api.acquireImageRead(full), h.host.api.acquireImageRead(small)])
    expect(results).toEqual([{ width: 800, height: 600, mime: 'image/jpeg' }, { width: 96, height: 72, mime: 'image/webp' }])
    const thumbnail = await h.host.api.imageReadFile(small.lease)
    expect(await sharp(join(dir, thumbnail)).metadata()).toMatchObject({ width: 96, height: 72 })
    await expect(h.host.api.acquireImageRead({ ...full, lease: randomUUID(), maxEdge: 0 })).rejects.toThrow('CAPABILITY_INVALID_INPUT')
    await h.host.scheduler.idle()
  } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }) }
})
