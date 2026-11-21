import { legacyDecorationSchema, themeDecorationSchema, themeImageName } from './theme-decoration'
import { iconReferences } from './theme-icons'
import { z } from 'zod'
import { legacyThemePartsSchema, themePartsSchema } from './theme-parts'
import { CLASSIC_THEMES, type ColorSchemeMode, type ThemePreset, type ThemeTokens, type ThemeVisual } from './theme-presets'

export const MAX_MANIFEST_BYTES = 32 * 1024
export const MAX_THEME_BYTES = 8 * 1024 * 1024
const themeColor = z.string().regex(/^#[0-9a-f]{6}$/i)
const colors = z.strictObject({
  shell: themeColor, panel: themeColor, panel2: themeColor, bg: themeColor, elevated: themeColor,
  line: themeColor, text: themeColor, muted: themeColor, accent: themeColor, danger: themeColor,
  placeholder: themeColor, paper: themeColor, ink: themeColor
} satisfies Record<Exclude<keyof ThemeTokens, 'scheme'>, typeof themeColor>).partial()
const readingFonts = {
  system: 'system-ui, sans-serif',
  serif: "'Songti SC', 'Noto Serif CJK SC', serif",
  mono: "ui-monospace, 'SF Mono', Consolas, monospace"
}
const identity = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default('')
}
const common = {
  ...identity,
  base: z.string().refine(id => CLASSIC_THEMES.some(p => p.id === id), '请选择已知的内置主题'),
  colors: colors.optional(),
  appearance: z.strictObject({
    density: z.enum(['comfortable', 'compact']).optional(),
    radius: z.enum(['sharp', 'rounded', 'soft']).optional(),
    panelInset: z.number().int().min(0).max(16).optional(),
    readingFont: z.enum(['system', 'serif', 'mono']).optional()
  }).optional()
}
const modernVisual = {
  colors: common.colors, parts: themePartsSchema.optional(), decoration: themeDecorationSchema.optional(),
  icons: iconReferences.optional(), preview: z.string().regex(themeImageName).optional()
}
function variant(scheme: ColorSchemeMode) {
  return z.strictObject({ ...modernVisual, base: common.base.refine(id =>
    CLASSIC_THEMES.some(p => p.id === id && p.tokens.scheme === scheme), '基础主题与分支明暗不一致') })
}
export const themeManifestSchema = z.discriminatedUnion('formatVersion', [
  z.strictObject({ ...common, formatVersion: z.literal(1) }),
  z.strictObject({ ...common, formatVersion: z.literal(2), parts: legacyThemePartsSchema.optional() }),
  z.strictObject({ ...common, formatVersion: z.literal(3), parts: legacyThemePartsSchema.optional(), decoration: legacyDecorationSchema.optional() }),
  z.strictObject({ ...common, formatVersion: z.literal(4), parts: themePartsSchema.optional(), decoration: legacyDecorationSchema.optional(), icons: iconReferences.optional() }),
  z.strictObject({ ...common, ...modernVisual, formatVersion: z.literal(5) }),
  z.strictObject({ ...identity, formatVersion: z.literal(6), appearance: common.appearance,
    variants: z.strictObject({ light: variant('light'), dark: variant('dark') }) })
])
export type ThemePackage = z.infer<typeof themeManifestSchema>

type PairedTheme = Extract<ThemePackage, { formatVersion: 6 }>
export type PackageVisual = Exclude<ThemePackage, PairedTheme> | PairedTheme['variants']['light']

function resolveVisual(visual: PackageVisual): ThemeVisual {
  const base = CLASSIC_THEMES.find(p => p.id === visual.base)!
  return {
    tokens: { ...base.tokens, ...visual.colors },
    parts: 'parts' in visual ? visual.parts : undefined,
    preview: 'preview' in visual ? visual.preview : undefined,
    decoration: 'decoration' in visual ? visual.decoration : undefined
  }
}

export function resolvePackage(pkg: ThemePackage, id = 'external:' + pkg.id): ThemePreset {
  const overrides = pkg.appearance
  const defaults = pkg.formatVersion === 6 ? undefined : CLASSIC_THEMES.find(p => p.id === pkg.base)?.appearance
  const visual = resolveVisual(pkg.formatVersion === 6 ? pkg.variants.light : pkg)
  const variants = pkg.formatVersion === 6 ? { light: visual, dark: resolveVisual(pkg.variants.dark) } : undefined
  return {
    id, name: pkg.name, description: pkg.description,
    ...visual, variants,
    appearance: {
      density: overrides?.density ?? defaults?.density ?? 'comfortable',
      radius: overrides?.radius ?? defaults?.radius ?? 'rounded',
      panelInset: overrides?.panelInset ?? defaults?.panelInset ?? 0,
      readingFont: overrides?.readingFont ? readingFonts[overrides.readingFont] : defaults?.readingFont ?? 'inherit'
    }
  }
}

export function parseTheme(value: unknown): ThemePackage {
  const parsed = themeManifestSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const field = issue.path.join('.')
  if (issue.code === 'unrecognized_keys') throw new Error('主题包包含未知字段：' + (field ? field + '.' : '') + issue.keys[0])
  if (field === 'formatVersion') throw new Error('主题包的 formatVersion 需为 1 至 6 的整数')
  if (field === 'variants.light.base' || field === 'variants.dark.base') throw new Error(field + ' 需要同一明暗模式的内置主题')
  if (field === 'base') throw new Error('主题包的 base 需要填写内置主题 ID')
  if (field.startsWith('colors.')) throw new Error(field + ' 需要填写 #RRGGBB 色值')
  throw new Error('主题包无效（' + (field || '清单') + '）')
}
