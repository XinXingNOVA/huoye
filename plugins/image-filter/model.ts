export const SHAPES = ['方图', '横图', '竖图', '长横图', '长竖图']
/** 按已解码图片的方向与尺寸分类；长图阈值含边界，方图只接受等宽高。 */
export function geometry(width: unknown, height: unknown) {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const ratio = width / height
  const shape = width === height ? '方图' : ratio >= 3 ? '长横图' : ratio <= 1 / 3 ? '长竖图' : width > height ? '横图' : '竖图'
  return { shape, ratio, longSide: Math.max(width, height), shortSide: Math.min(width, height) }
}
export function parseRange(minText: string, maxText: string): { min?: number; max?: number } {
  const parse = (text: string) => {
    if (!text.trim()) return undefined
    const n = Number(text)
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('请输入大于 0 的整数像素')
    return n
  }
  const min = parse(minText), max = parse(maxText)
  if (min !== undefined && max !== undefined && min > max) throw new Error('最小尺寸不能大于最大尺寸')
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
}
