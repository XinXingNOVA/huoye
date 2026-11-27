import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { UtilityProcess } from 'electron'
import { expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { ImageReads } from '../../src/core/image-reads'
import { inspectImage } from '../../src/core/job-image'
import { MediaSlots } from '../../src/shared/media-slots'
import { CoreMediaSlots, type MediaSlotReply } from '../../src/core/media-slots'
import { serveMediaSlots } from '../../src/main/media-slots'
import type { ImageReadRequest } from '../../src/shared/image-reads'

it('跨库后台占满时可读取；已排队的预取可原地升为当前页', async () => {
  const heavy = new MediaSlots(2)
  function connect() {
    const core = new EventEmitter()
    const slots = new CoreMediaSlots(msg => core.emit('message', msg))
    const transport = Object.assign(core, { postMessage: (reply: MediaSlotReply) => slots.reply(reply) })
    serveMediaSlots(transport as unknown as UtilityProcess, heavy)
    return slots
  }
  const a = connect(), b = connect(), life = AbortSignal.timeout(3000)
  const background = await Promise.all([a.acquire(life, 'background', 'heavy'), a.acquire(life, 'background', 'heavy')])
  const reading = await Promise.all([b.acquire(life, 'interactive', 'read'), b.acquire(life, 'interactive', 'read')])
  const order: number[] = []
  const old = b.acquire(life, 'background', 'read').then(release => { order.push(19); release() })
  const promote = new AbortController()
  const current = b.acquire(life, 'background', 'read', promote.signal).then(release => { order.push(18); release() })
  promote.abort()
  reading[0]()
  await Promise.all([old, current])
  expect(order).toEqual([18, 19])
  reading[1]()
  background.forEach(release => release())
})

it('两个窗口共用一笔计算，释放一个句柄或碰到容量上限都保住另一个显示中的页面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huoye-image-test-'))
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer()
  const image = await inspectImage(bytes, 'image')
  let finish!: () => void
  const first = new Promise<void>(resolve => { finish = resolve })
  let promotion: AbortSignal | undefined
  const readImage = vi.fn(async (_req, _locate, _signal, promote) => { promotion = promote; await first; return image })
  let seq = 1
  const cache = new ImageReads(dir, { readInput: (_p, _c, input) => input, readImage }, source => {
    if (source.fileSeq !== seq) throw Error('source changed')
    return 'original'
  }, bytes.byteLength)
  const req = (page: number, priority: ImageReadRequest['priority'] = 'display'): ImageReadRequest => ({
    lease: randomUUID(), plugin: 'client', capability: 'demo/book.page@1', priority, input: { id: 'book', fileSeq: 1, params: { page } }
  })
  try {
    const preload = req(18, 'prefetch'), display = req(18)
    const low = cache.acquire(preload)
    await Promise.resolve()
    expect(promotion?.aborted).toBe(false)
    const high = cache.acquire(display)
    expect(promotion?.aborted).toBe(true)
    finish()
    await Promise.all([low, high])
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(cache.file(preload.lease)).toBe(cache.file(display.lease))
    cache.release(preload.lease)
    await expect(cache.acquire(req(19))).rejects.toThrow('CAPABILITY_BUSY')
    expect(readdirSync(dir)).toEqual([cache.file(display.lease)])
    seq++
    expect(() => cache.file(display.lease)).toThrow('source changed')
    seq--
    rmSync(join(dir, cache.file(display.lease))) // 系统清理临时文件后仍可回收配额。
    cache.release(display.lease)
    const fresh = req(19)
    await cache.acquire(fresh)
    expect(readdirSync(dir)).toEqual([cache.file(fresh.lease)])
    expect(() => cache.file(display.lease)).toThrow('EXPIRED')
  } finally { cache.close(); expect(readdirSync(dir)).toEqual([]); rmSync(dir, { recursive: true }) }
})

it('并发读图失败后，释放旧句柄时的新请求能独立重新计算', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huoye-retry-'))
  try {
    const image = await inspectImage(await sharp({ create: { width: 1, height: 1, channels: 3, background: 'blue' } }).png().toBuffer(), 'image')
    const readImage = vi.fn().mockRejectedValueOnce(Error('临时读取失败')).mockResolvedValue(image)
    const cache = new ImageReads(dir, { readInput: (_p, _c, input) => input, readImage }, () => 'source')
    const req = (): ImageReadRequest => ({ lease: randomUUID(), plugin: 'p', capability: 'p/test.page@1',
      priority: 'display', input: { id: 'source', fileSeq: 1, params: {} } })
    const retry = req()
    let next: Promise<unknown> | undefined
    const release = cache.release.bind(cache)
    vi.spyOn(cache, 'release').mockImplementation(lease => {
      next ??= cache.acquire(retry)
      release(lease)
    })
    const results = await Promise.allSettled([cache.acquire(req()), cache.acquire(req())])
    expect(results.map(result => result.status)).toEqual(['rejected','rejected'])
    await next
    expect(readImage).toHaveBeenCalledTimes(2)
    rmSync(join(dir, cache.file(retry.lease)))
    cache.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('图像族拒收其他编码和超像素图，但固定格式契约仍校验确切编码', async () => {
  const make = () => sharp({ create: { width: 10, height: 20, channels: 3, background: 'white' } })
  await expect(inspectImage(await make().gif().toBuffer(), 'image')).rejects.toThrow('INVALID_OUTPUT')
  await expect(inspectImage(await make().png().toBuffer(), 'jpeg')).rejects.toThrow('INVALID_OUTPUT')
  const largeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"/>')
  await expect(inspectImage(largeSvg, 'image')).rejects.toThrow('INVALID_OUTPUT')
})
