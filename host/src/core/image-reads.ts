import { validateMaxEdge } from './job-image'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { canonical } from '../shared/external-plugins'
import type { ImageReadInput, ImageReadInfo, ImageReadRequest } from '../shared/image-reads'
import type { LibraryCapabilities } from './capabilities'
import type { MediaSource } from '../plugin-api/core/capabilities'

type Entry = {
  key: string; input: ImageReadInput; refs: number; size: number; file?: string
  completed: Promise<ImageReadInfo>; lifetime: AbortController; promotion: AbortController
}

/** A lease pins one immutable result. The entry map doubles as the least-recently-used list. */
export class ImageReads {
  private readonly entries = new Map<string, Entry>()
  private readonly leases = new Map<string, Entry>()
  private used = 0
  private closed = false
  constructor(private readonly directory: string | undefined, private readonly caps: Pick<LibraryCapabilities, 'readInput' | 'readImage'>,
    private readonly locate: (source: MediaSource) => string, private readonly budget = 128 * 1024 * 1024) {}

  async acquire(req: ImageReadRequest): Promise<ImageReadInfo> {
    if (this.closed || !this.directory) throw Error('[LIBRARY_OFFLINE] 阅读会话已关闭')
    if (!/^[0-9a-f-]{36}$/.test(req.lease) || this.leases.has(req.lease) || this.leases.size >= 2048) throw Error('[CAPABILITY_BUSY] 无效或过多的取图请求')
    validateMaxEdge(req.maxEdge)
    const input = this.caps.readInput(req.plugin, req.capability, req.input)
    this.locate(input)
    const key = canonical([req.capability, input, req.maxEdge ?? null])
    let entry = this.entries.get(key)
    if (entry?.file && !entry.refs && !existsSync(join(this.directory, entry.file))) {
      this.drop(entry)
      entry = undefined
    }
    if (!entry) {
      if (this.entries.size >= 512 && !this.evict()) throw Error('[CAPABILITY_BUSY] 阅读缓存正被占用')
      const created: Entry = { key, input, refs: 0, size: 0,
        completed: Promise.resolve().then(() => this.load(created, req)).catch(error => {
          this.drop(created)
          throw error
        }),
        lifetime: new AbortController(), promotion: new AbortController() }
      this.entries.set(key, created)
      entry = created
    } else {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    this.leases.set(req.lease, entry)
    entry.refs++
    if (req.priority === 'display' && !entry.promotion.signal.aborted) entry.promotion.abort()
    try {
      const info = await entry.completed
      if (this.leases.get(req.lease) !== entry) throw Error('[CAPABILITY_EXPIRED] 页面已释放')
      this.locate(input)
      return info
    } catch (error) {
      if (this.leases.get(req.lease) === entry) this.release(req.lease)
      throw error
    }
  }

  private async load(entry: Entry, req: ImageReadRequest): Promise<ImageReadInfo> {
    const signal = entry.lifetime.signal
    const output = await this.caps.readImage(req, this.locate, signal, entry.promotion.signal)
    signal.throwIfAborted()
    const size = output.bytes.byteLength
    while (this.used + size > this.budget) {
      if (!this.evict()) throw Error('[CAPABILITY_BUSY] 使用中的图片已占满阅读缓存')
    }
    entry.size = size
    this.used += size
    const file = randomUUID() + '.' + output.format
    const path = join(this.directory!, file)
    try {
      await writeFile(path, output.bytes, { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      this.locate(entry.input)
      entry.file = file
      return { width: output.width, height: output.height, mime: output.mime }
    } catch (error) { await rm(path, { force: true }); throw error }
  }
  private evict() {
    for (const e of this.entries.values()) if (!e.refs && e.file) { this.drop(e); return true }
    return false
  }
  private drop(e: Entry) {
    if (this.entries.get(e.key) !== e) return
    this.entries.delete(e.key)
    e.lifetime.abort()
    this.used -= e.size
    if (e.file) {
      try { rmSync(join(this.directory!, e.file), { force: true }) }
      catch (error) { console.warn('[media] 临时图像未能移除', error) }
    }
  }
  release(lease: string) {
    const e = this.leases.get(lease)
    if (!e) return
    this.leases.delete(lease)
    if (!--e.refs && !e.file) this.drop(e)
  }
  file(lease: string) {
    const e = this.leases.get(lease)
    if (!e?.file) throw Error('[CAPABILITY_EXPIRED] 图片句柄已释放')
    this.locate(e.input)
    return e.file
  }
  close() {
    this.closed = true
    this.leases.clear()
    for (const e of this.entries.values()) this.drop(e)
  }
}
