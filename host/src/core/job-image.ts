import sharp from 'sharp'
import { MAX_PROVIDER_BYTES } from './provider-transfer'
import { createHash } from 'node:crypto'
import type { ImageComposition } from '../plugin-api/core/images'

export function validateMaxEdge(edge: number | undefined) {
  if (edge !== undefined && (!Number.isInteger(edge) || edge < 1 || edge > 1024)) throw Error('[CAPABILITY_INVALID_INPUT] 缩略图最长边须为 1–1024')
}
export async function inspectImage(data: Uint8Array, format: import('./provider-transfer').ImageArtifact, maxEdge?: number) {
  validateMaxEdge(maxEdge)
  if (!data.byteLength || data.byteLength > MAX_PROVIDER_BYTES) throw Error('[CAPABILITY_OUTPUT_LIMIT] 图片字节超限')
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const info = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata().catch(() => undefined)
  if (!info || !['png', 'webp', 'jpeg'].includes(info.format) || (format !== 'image' && info.format !== format) ||
      !info.width || !info.height || info.width * info.height * (info.pages ?? 1) > 64 * 1024 * 1024) {
    throw Error('[CAPABILITY_INVALID_OUTPUT] 图片与声明的格式或尺寸不符')
  }
  if (maxEdge !== undefined) {
    const thumb = await sharp(bytes).rotate().resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
    return { format: 'webp', mime: 'image/webp', width: thumb.info.width, height: thumb.info.height, bytes: thumb.data }
  }
  return { format: info.format, mime: 'image/' + info.format, width: info.width, height: info.height, bytes }
}

export async function stageImageArtifact(system: string, id: string, data: Uint8Array, declared: import('./provider-transfer').ImageArtifact, maxEdge?: number) {
  const { format, bytes } = await inspectImage(data, declared, maxEdge)
  const name = createHash('sha256').update(JSON.stringify([system, id])).digest('hex')
  const source = createHash('sha256').update(bytes).digest().readUIntBE(0, 6)
  return { path: 'cache/provider-images/' + name + '.' + format, bytes, source }
}

export async function renderJobImage(image: ImageComposition, locate: (ref: string) => string, signal: AbortSignal) {
  const pixels = (value: number) => Number.isInteger(value) && value >= 1 && value <= 1024
  if (!pixels(image.width) || !pixels(image.height) || !Array.isArray(image.tiles) || image.tiles.length > 16) throw Error('合成图像最大 1024 × 1024，最多 16 个区域')
  const layers: { input: Buffer; left: number; top: number }[] = []
  for (const tile of image.tiles) {
    signal.throwIfAborted()
    if (![tile.x, tile.y].every(n => Number.isInteger(n) && n >= 0) || !pixels(tile.width) || !pixels(tile.height) ||
        tile.x + tile.width > image.width || tile.y + tile.height > image.height) throw Error('合成区域越界')
    // 先按 EXIF 转正并缩到有界尺寸，再按插件声明的比例裁切。
    const input = sharp(locate(tile.source), { animated: false }).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    const { data, info } = await input.png().toBuffer({ resolveWithObject: true })
    const picture = sharp(data)
    if (tile.crop) {
      const { x, y, width, height } = tile.crop
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || x + width > 1.00001 || y + height > 1.00001) throw Error('合成图裁切范围无效')
      const left = Math.floor(x * info.width), top = Math.floor(y * info.height)
      picture.extract({
        left, top,
        width: Math.max(1, Math.min(info.width - left, Math.round(width * info.width))),
        height: Math.max(1, Math.min(info.height - top, Math.round(height * info.height)))
      })
    }
    if (tile.grayscale) picture.grayscale()
    const bytes = await picture.resize(tile.width, tile.height, { fit: 'cover' }).png().toBuffer()
    let inputBytes = bytes
    if (tile.flipX || tile.flipY) {
      const mirrored = sharp(bytes)
      if (tile.flipX) mirrored.flop()
      if (tile.flipY) mirrored.flip()
      inputBytes = await mirrored.png().toBuffer()
    }
    layers.push({ input: inputBytes, left: tile.x, top: tile.y })
  }
  signal.throwIfAborted()
  const canvas = sharp({ create: { width: image.width, height: image.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  if (layers.length) canvas.composite(layers)
  const bytes = await canvas.webp({ quality: 84 }).toBuffer()
  return { bytes, source: createHash('sha256').update(bytes).digest().readUIntBE(0, 6) }
}
