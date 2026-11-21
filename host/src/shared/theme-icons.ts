import { z } from 'zod'
import { iconPaths, type IconName } from './icon-catalog'

export const iconName = z.enum(Object.keys(iconPaths) as [IconName, ...IconName[]])
export const iconFile = /^icons\/[a-z][a-z0-9-]{0,63}\.svg$/
export const iconReferences = z.partialRecord(iconName, z.string().regex(iconFile))
const scalar = z.string().max(20).regex(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i)
const numbers = z.string().max(4096).regex(/^[\d.,eE+\s-]+$/)
const paint = z.string().regex(/^(?:none|currentColor|transparent|#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i)
const attributes = z.strictObject({
  fill: paint, stroke: paint, strokeWidth: scalar, opacity: scalar, fillOpacity: scalar, strokeOpacity: scalar,
  fillRule: z.enum(['nonzero', 'evenodd']), strokeLinecap: z.enum(['round', 'butt', 'square']),
  strokeLinejoin: z.enum(['round', 'miter', 'bevel']), d: z.string().max(8192).regex(/^[\d.,\sMmZzLlHhVvCcSsQqTtAaEe+-]+$/),
  x: scalar, y: scalar, width: scalar, height: scalar, rx: scalar, ry: scalar, cx: scalar, cy: scalar, r: scalar,
  x1: scalar, x2: scalar, y1: scalar, y2: scalar, points: numbers
}).partial()
const shape = z.strictObject({ tag: z.enum(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']), attrs: attributes })
export const iconDrawing = z.strictObject({
  viewBox: numbers.refine(v => {
    const values = v.trim().split(/[\s,]+/).map(Number)
    return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
  }),
  shapes: z.array(shape).min(1).max(64)
})
export const themeIconsSchema = z.partialRecord(iconName, iconDrawing)
export type IconDrawing = z.infer<typeof iconDrawing>
export type ThemeIcons = z.infer<typeof themeIconsSchema>
