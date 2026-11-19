import { z } from 'zod'
import type { CollectionState, CollectionLayoutState, LayoutPresentation } from './collection'

const object = z.record(z.string(), z.json())
export const layoutConfigurationSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  defaultOptions: object.optional(),
  size: z.union([z.literal(false), z.object({
    label: z.string().trim().min(1).max(40), min: z.number().finite().positive(), max: z.number().finite().positive(),
    step: z.number().finite().positive().optional(), default: z.number().finite().positive()
  }).refine(s => s.max > s.min && s.default >= s.min && s.default <= s.max && (s.step ?? 1) <= s.max - s.min)]).optional()
})
type Configuration = { defaultOptions?: Record<string, unknown>; size?: false | { label: string; min: number; max: number; step?: number; default: number } }
const legacySize = { label: '卡片大小', min: 120, max: 480, step: 1, default: 220 }
export const layoutSize = (layout: Configuration) => layout.size === undefined ? legacySize : layout.size
export function layoutZoom(layout: Configuration, value?: number): number {
  const size = layoutSize(layout)
  if (!size) return 220
  const n = typeof value === 'number' && Number.isFinite(value) ? value : size.default
  return Math.max(size.min, Math.min(size.max, n))
}
export const layoutOptions = (layout: Configuration, value?: Record<string, unknown>) => ({ ...structuredClone(layout.defaultOptions ?? {}), ...value })

/** 私有状态必须可保存；拒绝循环、函数、DOM 与无限数，不能静默丢字段。 */
export function layoutRecord(value: unknown): Record<string, unknown> {
  const parsed = object.safeParse(value)
  if (!parsed.success) throw new Error('布局配置与状态必须是可保存的 JSON 对象')
  if (JSON.stringify(parsed.data).length > 64 * 1024) throw new Error('布局配置或状态超过 64 KB，请只保存界面状态')
  return parsed.data
}
const layoutStateSchema = z.object({ options: object.optional(), state: object.optional(), zoom: z.number().finite().optional(), anchor: z.string().optional() })
export const presentationSchema = z.object({ layout: z.string().min(1).max(150), options: object, zoom: z.number().finite().optional() })
export function restoreLayoutStates(saved: CollectionState | undefined, current: string): Record<string, CollectionLayoutState> {
  const entries = Object.entries(saved?.layouts ?? {}).flatMap(([id, value]) => {
    const parsed = layoutStateSchema.safeParse(value)
    return parsed.success ? [[id, parsed.data] as const] : []
  })
  const states = Object.fromEntries(entries)
  // 旧存档的唯一锚点／尺寸只属于当时所选布局，不分发到其他布局。
  if (!states[current] && (saved?.zoom !== undefined || saved?.anchor)) {
    const old = layoutStateSchema.safeParse({ zoom: saved.zoom, anchor: saved.anchor })
    if (old.success) states[current] = old.data
  }
  return states
}
const preferenceKey = (libraryId: string) => `rm:browsing-default:${libraryId}`
export function readBrowsingDefault(storage: Pick<Storage, 'getItem'>, libraryId: string): LayoutPresentation {
  try {
    const value = JSON.parse(storage.getItem(preferenceKey(libraryId)) ?? 'null')
    const parsed = presentationSchema.safeParse(value?.version === 1 ? value.presentation : undefined)
    if (parsed.success) return parsed.data
  } catch { /* 本机坏偏好不阻止打开仓库。 */ }
  return { layout: 'masonry', options: {} }
}
export function saveBrowsingDefault(storage: Pick<Storage, 'setItem' | 'removeItem'>, libraryId: string, value?: LayoutPresentation): void {
  if (!value) { storage.removeItem(preferenceKey(libraryId)); return }
  const presentation = presentationSchema.parse({ ...value, options: layoutRecord(value.options) })
  storage.setItem(preferenceKey(libraryId), JSON.stringify({ version: 1, presentation }))
}
