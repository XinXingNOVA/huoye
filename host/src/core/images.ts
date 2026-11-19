import sharp from 'sharp'
import { LibraryFiles } from '../storage/library-files'
import type { ImageCrop, ImageTools } from '../plugin-api/core/images'

export function imageTools(storage: LibraryFiles | string): ImageTools {
  const files = typeof storage === 'string' ? new LibraryFiles(storage) : storage
  return { async sample({ source, maxSide }, signal) {
    signal.throwIfAborted()
    if (!Number.isInteger(maxSide) || maxSide < 1 || maxSide > 256) throw new Error('采样最长边必须为 1～256')
    const pipeline = sharp(files.readable(source), { animated: false }).rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').removeAlpha().raw()
    const abort = () => pipeline.destroy(new Error('已取消采样'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      return { data, width: info.width, height: info.height }
    } finally { signal.removeEventListener('abort', abort) }
  }, async crop({ source, destination, region, maxSide, quality }: ImageCrop, signal) {
    signal.throwIfAborted()
    const inputPath = files.readable(source)
    files.resolve(destination)
    if (!destination.startsWith('cache/') || !destination.endsWith('.jpg')) throw new Error('裁图只允许输出 cache 内的 JPEG')
    const { x, y, w, h } = region
    if (![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0 || x >= 1 || y >= 1 || w <= 0 || h <= 0 || x + w > 1.00001 || y + h > 1.00001 ||
      !Number.isInteger(maxSide) || maxSide < 1 || maxSide > 8192 || !Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('裁剪区域或输出尺寸无效')
    files.directory(destination.split('/').slice(0, -1).join('/'))
    const input = sharp(inputPath, { animated: false }).rotate()
    const meta = await input.metadata(), turned = (meta.orientation ?? 1) >= 5
    const W = (turned ? meta.height : meta.width) ?? 0, H = (turned ? meta.width : meta.height) ?? 0
    if (!W || !H) throw new Error('读不到图像尺寸')
    const left = Math.floor(x * W), top = Math.floor(y * H)
    const width = Math.max(1, Math.min(W - left, Math.round(w * W))), height = Math.max(1, Math.min(H - top, Math.round(h * H)))
    signal.throwIfAborted()
    const pipeline = sharp(await input.toBuffer()).extract({ left, top, width, height })
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).jpeg({ quality })
    const abort = () => pipeline.destroy(new Error('已取消裁剪'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
      signal.throwIfAborted(); files.write(destination, data)
      return { width: info.width, height: info.height }
    } finally { signal.removeEventListener('abort', abort) }
  } }
}
