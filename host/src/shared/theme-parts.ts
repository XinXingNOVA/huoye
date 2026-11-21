import { z } from 'zod'

const px = (min: number, max: number) => z.number().int().min(min).max(max)
export const themeTone = z.enum(['shell', 'panel', 'panel2', 'elevated', 'line', 'accent', 'danger', 'placeholder', 'paper', 'ink', 'bg', 'text', 'muted'])
const readerPage = z.strictObject({
  maxWidth: px(420, 1200).optional(), inset: px(8, 72).optional(),
  textSize: px(13, 24).optional(), lineHeight: z.number().min(1.3).max(2.4).optional()
})
export const legacyThemePartsSchema = z.strictObject({
  'card-cover': z.strictObject({
    frameWidth: px(0, 6).optional(), frameColor: themeTone.optional(), radius: px(0, 24).optional()
  }).optional(),
  'card-caption': z.strictObject({
    placement: z.enum(['below', 'overlay']).optional(), align: z.enum(['start', 'center', 'end']).optional(),
    weight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).optional()
  }).optional(),
  'inspector-section': z.strictObject({
    background: themeTone.optional(), radius: px(0, 16).optional(), inset: px(0, 16).optional()
  }).optional(),
  'reader-page': readerPage.optional()
})
export const themePartsSchema = legacyThemePartsSchema.extend({
  'reader-page': readerPage.extend({
    paperColor: themeTone.optional(), inkColor: themeTone.optional(), surround: themeTone.optional(),
    pdfPaper: z.enum(['original', 'warm', 'dark']).optional()
  }).optional()
})
export type ThemeParts = z.infer<typeof themePartsSchema>
