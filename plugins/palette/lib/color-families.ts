import type { Cond } from '@resource-manager/plugin-api/query'

export const FAMILY_KIND = 'palette.families'
export const FAMILIES = [
  { name: '红色', color: '#e34b4b' }, { name: '橙色', color: '#f28c28' },
  { name: '黄色', color: '#e6ce38' }, { name: '绿色', color: '#4baf65' },
  { name: '青色', color: '#35bcb6' }, { name: '蓝色', color: '#4685df' },
  { name: '紫色', color: '#925ed1' }, { name: '粉色', color: '#e66fa8' },
  { name: '棕色', color: '#91613c' }, { name: '黑色', color: '#242424' },
  { name: '灰色', color: '#999999' }, { name: '白色', color: '#f5f5f5' }
] as const
export type Family = typeof FAMILIES[number]['name']

/** 确定性的 sRGB → HSV 标准色系归类；用于粗筛，不表示感知色差或主色排序。 */
export function colorFamily(hex: unknown): Family | undefined {
  if (typeof hex !== 'string' || !/^#[\da-f]{6}$/i.test(hex)) return undefined
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  if (max <= 0.16) return '黑色'
  const saturation = delta / max
  if (saturation <= 0.12) return max >= 0.9 ? '白色' : '灰色'
  let hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  hue = (hue * 60 + 360) % 360
  if (hue >= 15 && hue < 55 && max <= 0.65) return '棕色'
  if ((hue >= 345 || hue < 15) && max >= 0.75 && saturation < 0.5) return '粉色'
  if (hue < 15 || hue >= 345) return '红色'
  if (hue < 45) return '橙色'
  if (hue < 70) return '黄色'
  if (hue < 165) return '绿色'
  if (hue < 200) return '青色'
  if (hue < 260) return '蓝色'
  if (hue < 300) return '紫色'
  return '粉色'
}

/** 同一素材的多个色块落入同一色系只记一次，分面统计素材数。 */
export function paletteFamilies(colors: unknown): Family[] {
  const found = new Set(Array.isArray(colors) ? colors.map(colorFamily).filter(Boolean) : [])
  return FAMILIES.filter(f => found.has(f.name)).map(f => f.name)
}
export function familyCondition(family: Family): Cond {
  return { op: 'eq', kind: FAMILY_KIND, field: 'values', value: family }
}
