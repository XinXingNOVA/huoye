import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { corePlugins } from '../../src/plugins/core'
import { previewPlugin } from '../../src/plugins/preview/core'
import { openHost, tempDir } from '../helpers/helpers'

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

function setup(root?: string, plugins = corePlugins) {
  const h = openHost(plugins, { concurrency: 2 }, root)
  cleanups.push(h.cleanup)
  return h
}

/** 左红右蓝的 300×200 图片。 */
async function makeImage(dir: string, name = 'sample.png'): Promise<string> {
  const path = join(dir, name)
  const left = await sharp({ create: { width: 150, height: 200, channels: 3, background: '#e03020' } }).png().toBuffer()
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#2040e0' } })
    .composite([{ input: left, left: 0, top: 0 }])
    .png()
    .toFile(path)
  return path
}

describe('接入与加工', () => {
  it('基础仓库拖入图片会生成图片块、代表图、缩略图和卡片宽高比', async () => {
    const { host, root } = setup()
    const src = await makeImage(tempDir())
    const [id] = await host.api.ingest([{ type: 'file', path: src }])
    await host.scheduler.idle()

    const [view] = host.store.get([id])
    expect(view.blocks.file.data).toMatchObject({ name: 'sample.png', ext: 'png', mime: 'image/png' })
    expect(existsSync(host.lib.files.readable(String(view.blocks.file.data.path)))).toBe(true)
    expect(view.blocks.image.data).toEqual({ width: 300, height: 200, animated: false })
    // 图片的代表图直接指向原图，不产生新文件
    expect(view.blocks.still.data.path).toBe(view.blocks.file.data.path)
    expect(existsSync(join(root, String(view.blocks.thumb.data.path)))).toBe(true)

    expect(view.blocks.palette).toBeUndefined()

    const res = host.api.query({}) as { ids: string[]; aspects: number[] }
    expect(res.ids).toEqual([id])
    expect(res.aspects[0]).toBeCloseTo(1.5)
  })

  it('同样内容的文件只收录一次；在回收站里的会被恢复', async () => {
    const { host } = setup()
    const dir = tempDir()
    const src = await makeImage(dir)
    const [id] = await host.api.ingest([{ type: 'file', path: src }])
    const [again] = await host.api.ingest([{ type: 'file', path: src }])
    expect(again).toBe(id)
    host.api.trash([id])
    const [restored] = await host.api.ingest([{ type: 'file', path: src }])
    expect(restored).toBe(id)
    expect(host.store.isTrashed(id)).toBe(false)
  })

  it('坏文件：记录失败，不会反复重试', async () => {
    const { host } = setup()
    const bad = join(tempDir(), 'broken.jpg')
    writeFileSync(bad, Buffer.from('definitely not a jpeg'))
    const [id] = await host.api.ingest([{ type: 'file', path: bad }])
    await host.scheduler.idle()

    const [view] = host.store.get([id])
    expect(view.blocks.image).toBeUndefined()
    expect(view.failures['image.probe']).toBeTruthy()

    host.scheduler.rescan()
    await host.scheduler.idle()
    const attempts = host.lib.db
      .prepare("SELECT attempts FROM derived.derivation WHERE entity_id = ? AND system = 'image.probe'")
      .pluck()
      .get(id)
    expect(attempts).toBe(1)
  })

  it('非图片文件：图片插件跳过它，它仍然是素材', async () => {
    const { host } = setup()
    const txt = join(tempDir(), 'data.bin')
    writeFileSync(txt, 'hello')
    const [id] = await host.api.ingest([{ type: 'file', path: txt }])
    await host.scheduler.idle()
    const [view] = host.store.get([id])
    expect(Object.keys(view.blocks)).toEqual(['file'])
    expect((host.api.query({}) as { ids: string[] }).ids).toEqual([id])
  })

  it('粘贴文字成为素材；文件夹展开为其中的文件', async () => {
    const { host } = setup()
    const [t] = await host.api.ingest([{ type: 'text', text: '一段摘录' }])
    expect(host.store.blocksOf(t).text.data).toEqual({ content: '一段摘录' })

    const dir = tempDir()
    mkdirSync(join(dir, 'sub'))
    await makeImage(dir, 'a.png')
    await makeImage(join(dir, 'sub'), 'b.png')
    writeFileSync(join(dir, '.DS_Store'), 'x')
    const ids = await host.api.ingest([{ type: 'file', path: dir }])
    // a.png 与 b.png 内容相同，去重后是同一个身份
    expect(new Set(ids).size).toBe(1)
    expect(ids.length).toBe(2)
  })

  it('派生库被删掉后，重新打开会自动补算全部可重建数据', async () => {
    const { host, root } = setup()
    const src = await makeImage(tempDir())
    const [id] = await host.api.ingest([{ type: 'file', path: src }])
    await host.scheduler.idle()
    host.close()
    cleanups = []

    const { rmSync } = await import('node:fs')
    for (const f of ['derived.db', 'derived.db-wal', 'derived.db-shm']) rmSync(join(root, f), { force: true })

    const reopened = setup(root)
    expect(reopened.host.store.blocksOf(id).image).toBeUndefined()
    await reopened.host.scheduler.idle()
    const blocks = reopened.host.store.blocksOf(id)
    expect(blocks.image.data).toMatchObject({ width: 300, height: 200 })
    expect(existsSync(join(root, String(blocks.thumb.data.path)))).toBe(true)
    expect(blocks.palette).toBeUndefined()
  })

  it('插件版本变化：它产出的数据全部重新生成', async () => {
    const { host, root } = setup()
    const src = await makeImage(tempDir())
    const [id] = await host.api.ingest([{ type: 'file', path: src }])
    await host.scheduler.idle()
    const before = host.lib.db
      .prepare("SELECT updated_at FROM derived.derivation WHERE entity_id = ? AND system = 'preview.thumb'")
      .pluck()
      .get(id) as number
    host.close()
    cleanups = []

    await new Promise((r) => setTimeout(r, 5))
    const bumped = corePlugins.map((p) => (p.id === 'preview' ? { ...previewPlugin, version: 2 } : p))
    const reopened = setup(root, bumped)
    await reopened.host.scheduler.idle()
    const row = reopened.host.lib.db
      .prepare("SELECT plugin_ver, updated_at FROM derived.derivation WHERE entity_id = ? AND system = 'preview.thumb'")
      .get(id) as { plugin_ver: number; updated_at: number }
    expect(row.plugin_ver).toBe(2)
    expect(row.updated_at).toBeGreaterThan(before)
  })
})
