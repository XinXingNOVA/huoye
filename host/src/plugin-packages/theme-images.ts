const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function rasterFormat(data: Buffer) {
  if (data.subarray(0, 8).equals(png)) return 'png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'webp'
}

// 在同步的主题与套件安装流程中检查声明尺寸。WebP 的扩展画布与实际帧均需符合上限。
export function checkDecorationRaster(data: Buffer, name: string) {
  const invalid = () => new Error('装饰图片需要有效的静态 PNG 或 WebP：' + name)
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width * height > 16_000_000) throw new Error('装饰图片尺寸无效或超过 1600 万像素：' + name)
  }
  if (name.endsWith('.png')) {
    if (data.length < 33 || data.readUInt32BE(8) !== 13 || data.toString('latin1', 12, 16) !== 'IHDR') throw invalid()
    dimensions(data.readUInt32BE(16), data.readUInt32BE(20))
    let seenData = false
    for (let offset = 8; offset + 12 <= data.length;) {
      const size = data.readUInt32BE(offset), kind = data.toString('latin1', offset + 4, offset + 8)
      offset += 12 + size
      if (offset > data.length || kind === 'acTL') throw invalid()
      if (kind === 'IDAT') seenData = true
      if (kind === 'IEND' && seenData && size === 0 && offset === data.length) return
    }
    throw invalid()
  }
  if (data.length < 20 || data.readUInt32LE(4) + 8 !== data.length) throw invalid()
  let seenFrame = false
  let offset = 12
  while (offset + 8 <= data.length) {
    const kind = data.toString('latin1', offset, offset + 4), length = data.readUInt32LE(offset + 4)
    const start = offset + 8
    offset = start + length + (length % 2)
    if (offset > data.length || kind === 'ANIM' || kind === 'ANMF') throw invalid()
    if (kind === 'VP8X') {
      if (length !== 10 || (data[start] & 2)) throw invalid()
      dimensions(1 + data.readUIntLE(start + 4, 3), 1 + data.readUIntLE(start + 7, 3))
    } else if (kind === 'VP8L' || kind === 'VP8 ') {
      if (seenFrame) throw invalid()
      seenFrame = true
      if (kind === 'VP8L') {
        if (length < 5 || data[start] !== 0x2f) throw invalid()
        const bits = data.readUInt32LE(start + 1)
        dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff))
      } else {
        if (length < 10 || data.readUIntBE(start + 3, 3) !== 0x9d012a) throw invalid()
        dimensions(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff)
      }
    }
  }
  if (!seenFrame || offset !== data.length) throw invalid()
}
