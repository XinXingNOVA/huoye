import { z } from 'zod'
import { placementSchema, decorationControlKey, decorationSlot, type DecorationSlot, type LocalDecoration } from './theme-decoration'
import type { ThemePreset } from './theme-presets'

export const builtinDefaults = { presetId: 'huoye-standard', density: 'comfortable', radius: 'rounded' } as const
export const legacyThemeKey = 'huoye:theme-package:v1:'
export const legacyAppKey = 'rm:theme-preferences:v1'
export const legacyLibraryKey = 'huoye:library-appearance:v1:'
const color = z.string().regex(/^#[0-9a-f]{6}$/i)
const density = z.enum(['comfortable', 'compact'])
const radius = z.enum(['sharp', 'rounded', 'soft'])
const colors = z.object({ shell: color, panel: color, bg: color, text: color, paper: color, accent: color }).partial()
const colorMode = z.enum(['system', 'light', 'dark'])
const selection = z.object({ presetId: z.string().min(1).max(200), density, radius, accent: color.optional(), customTokens: colors.optional(), colorMode: colorMode.optional() })
export const preferencesSchema = selection.extend({ previousBuiltin: selection.optional() })
export type ThemePreferences = z.infer<typeof preferencesSchema>
export const themeActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('decorationPlacement'), value: placementSchema }),
  z.object({ action: z.literal('blurCards'), enabled: z.boolean() }),
  z.object({ action: z.literal('decorationControl'), key: decorationControlKey, value: z.number().int() }),
  z.object({ action: z.literal('hideDecoration'), slot: decorationSlot }),
  z.object({ action: z.literal('resetDecoration') }),
  z.object({ action: z.literal('materialWallpaper'), entityId: z.string().min(1).max(200) }),
  z.object({ action: z.literal('select'), id: z.string().min(1).max(200) }),
  z.object({ action: z.literal('colorMode'), value: colorMode }),
  z.object({ action: z.literal('independent') }), z.object({ action: z.literal('follow') }),
  z.object({ action: z.literal('restore') }), z.object({ action: z.literal('resetColors') }),
  z.object({ action: z.literal('accent'), value: color }), z.object({ action: z.literal('density'), value: density }),
  z.object({ action: z.literal('radius'), value: radius }), z.object({ action: z.literal('color'), key: colors.keyof(), value: color })
])
export type ThemeAction = z.infer<typeof themeActionSchema>
export interface AppearanceSnapshot {
  revision: number
  systemScheme: 'light' | 'dark'
  application: ThemePreferences
  decoration?: LocalDecoration
  library?: ThemePreferences
  warning?: string
  installed: ThemePreset[]
}
export interface AppearanceBridge {
  load(legacy?: Record<string, string>): Promise<AppearanceSnapshot & { migratedKeys?: string[] }>
  change(scope: 'application' | 'library', action: ThemeAction): Promise<AppearanceSnapshot>
  install(name: string, bytes: Uint8Array): Promise<AppearanceSnapshot>
  setDecorationImage(slot: DecorationSlot, bytes: Uint8Array): Promise<AppearanceSnapshot>
  remove(id: string): Promise<AppearanceSnapshot>
  onChanged(fn: () => void): () => void
}
