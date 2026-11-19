import { open } from 'node:fs/promises'
import sharp, { type Sharp, type OverlayOptions } from 'sharp'
import { readPreviewSchema, type PreviewItem, type PreviewResult, type ReadPreviewInput } from '../shared/preview'
import type { Store } from './store'
import type { Scheduler } from './scheduler'
import type { LibraryFiles } from '../storage/library-files'
import { parseSpaceReference } from '../storage/space-reference'

const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 // 小于本机通道的 4 MiB JSON 上限（含 base64）。
type Source = { kind: 'still' | 'thumb'; seq: number; path: string }
type Tile = { item: PreviewItem; pixels?: Buffer; source?: Source }

/** 仓库代表图的只读、限量快照；不接受外部路径，不读工作副本或窗口画面。 */
export class Previews {
  private readonly stopped = new AbortController()
  private busy = false
  constructor(private store: Store, private scheduler: Scheduler, private files: LibraryFiles) {}
  stop() { this.stopped.abort() }

  private snapshot(id: string) {
    this.stopped.signal.throwIfAborted()
    const status = this.scheduler.processingStatus({ ids: [id], kinds: ['still', 'thumb'] }).items[0]
    const blocks = this.store.blocksOf(id)
    const file = typeof blocks.file?.data.path === 'string' ? blocks.file.data.path : undefined
    const original = file ? { state: this.files.status(file).state, contentVersion: parseSpaceReference(file)?.contentVersion } : undefined
    return { status, blocks, original }
  }
  private current(tile: Tile) {
    const now = this.snapshot(tile.item.id), source = tile.source!
    try { this.files.readable(source.path) } catch { return false }
    return !['missing', 'trashed'].includes(now.status.state) && now.status.revision === tile.item.revision
      && now.status.kinds.find(k => k.kind === source.kind)?.state === 'ready'
      && now.blocks[source.kind]?.seq === source.seq && now.blocks[source.kind]?.data.path === source.path
  }
  private async bytes(path: string, signal: AbortSignal): Promise<Buffer> {
    // 固定句柄读取，避免派生文件原子替换时混合两版字节；增长也不能越过内存上限。
    const file = await open(this.files.readable(path), 'r')
    try {
      signal.throwIfAborted()
      const before = await file.stat()
      if (!before.isFile() || before.size > MAX_INPUT_BYTES) throw new Error('预览来源过大或不是普通文件')
      const buffer = Buffer.alloc(before.size)
      let offset = 0
      while (offset < buffer.length) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) throw new Error('读取期间预览文件已变化')
        offset += bytesRead
      }
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('读取期间预览文件已变化')
      return buffer
    } finally { await file.close() }
  }
  private async encode(pipeline: Sharp, signal: AbortSignal) {
    const abort = () => pipeline.destroy(new Error('预览读取已取消'))
    signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await pipeline.jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      if (result.data.length > MAX_IMAGE_BYTES) throw new Error('[PREVIEW_TOO_LARGE] 请减小 maxSide 后重试')
      return result
    } finally { signal.removeEventListener('abort', abort) }
  }
  private async tile(id: string, index: number, mode: 'single' | 'grid', side: number, expected: string | undefined, signal: AbortSignal): Promise<Tile> {
    const initial = this.snapshot(id), { status, blocks, original } = initial
    const item: PreviewItem = { id, index, revision: status.revision, state: 'unavailable', ...(original ? { original } : {}) }
    if (status.state === 'missing' || status.state === 'trashed') return { item: { ...item, state: status.state } }
    if (expected !== undefined && expected !== status.revision) return { item: { ...item, state: 'changed', reason: '素材版本已变化，请重新读取' } }
    const order = mode === 'single' ? ['still', 'thumb'] as const : ['thumb', 'still'] as const
    for (const kind of order) {
      if (status.kinds.find(k => k.kind === kind)?.state !== 'ready' || typeof blocks[kind]?.data.path !== 'string') continue
      const source: Source = { kind, seq: blocks[kind].seq, path: blocks[kind].data.path as string }
      try {
        const buffer = await this.bytes(source.path, signal)
        // 只解码第一帧，转正并重新编码；不把源格式／元信息直接透传给客户端。
        const resized = await this.encode(sharp(buffer, { animated: false, limitInputPixels: 64 * 1024 * 1024 }).rotate()
          .resize({ width: side, height: mode === 'grid' ? side - 32 : side, fit: 'inside', withoutEnlargement: mode === 'single' })
          .flatten({ background: '#f2f3f5' }).toColourspace('srgb'), signal)
        const tile: Tile = { item: { ...item, state: 'ready', source: { kind, seq: source.seq } }, pixels: resized.data, source }
        if (!this.current(tile)) return { item: { ...item, state: 'changed', reason: '读取期间素材或加工结果已变化' } }
        return tile
      } catch {
        signal.throwIfAborted()
        // 原件离线、过大或某份缓存缺失时，仍可尝试另一份新鲜的受控预览。
      }
    }
    const states = status.kinds
    const problem = states.find(s => s.state === 'pending') ?? states.find(s => s.state === 'failed') ?? states.find(s => s.state === 'blocked')
    if (states.some(s => s.state === 'ready')) item.reason = '当前预览文件不可用、过大或无法解码'
    else if (problem) { item.state = problem.state as PreviewItem['state']; item.reason = problem.reason ?? '预览仍在加工，请查询加工状态' }
    else { item.state = 'unsupported'; item.reason = '当前素材没有代表图或缩略图' }
    return { item }
  }
  async read(raw: ReadPreviewInput): Promise<PreviewResult> {
    const input = readPreviewSchema.parse(raw)
    if (this.stopped.signal.aborted) throw new Error('[LIBRARY_OFFLINE] 仓库已关闭')
    if (this.busy) throw new Error('[PREVIEW_BUSY] 正在生成另一批预览，请稍后重试')
    this.busy = true
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 10000)
    const signal = AbortSignal.any([this.stopped.signal, timeout.signal])
    try {
      const columns = Math.min(3, input.ids.length), rows = Math.ceil(input.ids.length / columns)
      const side = input.mode === 'single' ? input.maxSide : Math.floor(input.maxSide / Math.max(columns, rows))
      const tiles: Tile[] = []
      for (const [i, id] of input.ids.entries()) tiles.push(await this.tile(id, i + 1, input.mode, side, input.expectedRevisions?.[id], signal))
      const result: PreviewResult = { mode: input.mode, items: tiles.map(tile => tile.item) }
      if (!tiles.some(tile => tile.pixels)) return result
      let encoded: { data: Buffer; info: { width: number; height: number } }
      if (input.mode === 'single') {
        const data = tiles[0].pixels!, info = await sharp(data).metadata()
        encoded = { data, info: { width: info.width!, height: info.height! } }
      } else {
        const layers: OverlayOptions[] = []
        for (const [i, tile] of tiles.entries()) {
          const left = i % columns * side, top = Math.floor(i / columns) * side
          // 标签只含固定编号和受控状态，不把素材文字插入 SVG。
          const label = `<svg width="${side}" height="${side}"><rect width="100%" height="100%" fill="#f2f3f5" stroke="#c8cbd0"/><rect width="100%" height="32" fill="#252a34"/><text x="12" y="23" font-family="sans-serif" font-size="18" fill="white">#${i + 1}</text>${tile.pixels ? '' : `<text x="12" y="60" font-family="sans-serif" font-size="14" fill="#555">${tile.item.state}</text>`}</svg>`
          layers.push({ input: Buffer.from(label), left, top })
          if (tile.pixels) {
            const meta = await sharp(tile.pixels).metadata()
            layers.push({ input: tile.pixels, left: left + Math.floor((side - meta.width!) / 2), top: top + 32 + Math.floor((side - 32 - meta.height!) / 2) })
          }
        }
        encoded = await this.encode(sharp({ create: { width: columns * side, height: rows * side, channels: 3, background: '#f2f3f5' } }).composite(layers), signal)
      }
      signal.throwIfAborted()
      if (tiles.some(tile => tile.pixels && !this.current(tile))) throw new Error('[PREVIEW_CHANGED] 拼图期间素材或加工结果已变化，请重新读取')
      return { ...result, image: { mimeType: 'image/jpeg', data: encoded.data.toString('base64'), width: encoded.info.width, height: encoded.info.height } }
    } catch (error) {
      if (this.stopped.signal.aborted) throw new Error('[LIBRARY_OFFLINE] 仓库已关闭')
      if (timeout.signal.aborted) throw new Error('[PREVIEW_TIMEOUT] 本批预览超过等待上限，请减小批次或尺寸')
      throw error
    } finally { clearTimeout(timer); this.busy = false }
  }
}
