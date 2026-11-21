import { z } from 'zod'

export const themeImageName = /^images\/[a-z0-9][a-z0-9_-]{0,63}\.(png|webp)$/
export const managedImageName = /^[0-9a-f]{64}\.(png|webp)$/
export const maxPersonalImageBytes = 20 * 1024 * 1024
export const decorationSlot = z.enum(['wallpaper', 'sticker'])
export type DecorationSlot = z.infer<typeof decorationSlot>

export const stickerCorner = z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
export const wallpaperAnchor = z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'])
export const placementSchema = z.strictObject({
  wallpaperFit: z.enum(['cover', 'tile']).optional(),
  wallpaperAnchor: wallpaperAnchor.optional(),
  stickerAnchor: stickerCorner.optional()
})
export const defaultPlacement = { wallpaperFit: 'cover', wallpaperAnchor: 'center', stickerAnchor: 'bottom-right' } as const

export const decorationControls = {
  wallpaperTileSize: { min: 16, max: 1024, initial: 128, label: '纹理宽度', unit: 'px' },
  stickerScale: { min: 40, max: 200, initial: 100, label: '贴纸大小', unit: '%' },
  stickerOpacity: { min: 0, max: 100, initial: 78, label: '贴纸不透明度', unit: '%' },
  wallpaperOpacity: { min: 0, max: 100, initial: 35, label: '壁纸不透明度', unit: '%' },
  wallpaperBlur: { min: 0, max: 24, initial: 0, label: '壁纸模糊', unit: 'px' },
  wallpaperBrightness: { min: 40, max: 140, initial: 100, label: '壁纸亮度', unit: '%' },
  surfaceOpacity: { min: 45, max: 100, initial: 84, label: '表面不透明度', unit: '%' },
  surfaceBlur: { min: 0, max: 16, initial: 0, label: '毛玻璃模糊', unit: 'px' }
} as const
export type DecorationControl = keyof typeof decorationControls
const control = (key: DecorationControl) => z.number().int().min(decorationControls[key].min).max(decorationControls[key].max).optional()
const legacyControls = z.strictObject({ wallpaperOpacity: control('wallpaperOpacity'), wallpaperBlur: control('wallpaperBlur'),
  wallpaperBrightness: control('wallpaperBrightness'), surfaceOpacity: control('surfaceOpacity'), surfaceBlur: control('surfaceBlur') })

const controls = legacyControls.extend({
  stickerScale: control('stickerScale'), stickerOpacity: control('stickerOpacity'), wallpaperTileSize: control('wallpaperTileSize')
})
export const decorationControlKey = controls.keyof()
export const legacyDecorationSchema = legacyControls.extend({
  wallpaper: z.string().regex(themeImageName).optional(), sticker: z.string().regex(themeImageName).optional()
})
const cardEffects = { blurCards: z.boolean().optional() }
export const themeDecorationSchema = legacyDecorationSchema.extend({ ...controls.shape, ...placementSchema.shape, ...cardEffects })
const file = z.strictObject({ file: z.string().regex(managedImageName) })
export const localDecorationSchema = controls.extend({
  ...placementSchema.shape, ...cardEffects,
  wallpaper: z.union([file, z.strictObject({ entityId: z.string().min(1).max(200) })]).nullish(),
  sticker: file.nullish()
})
export type ThemeDecoration = z.infer<typeof themeDecorationSchema>
export type LocalDecoration = z.infer<typeof localDecorationSchema>
