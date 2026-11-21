import { z } from 'zod'

const dictionary = z.record(z.string().min(1).max(2000), z.string().min(1).max(2000))
  .refine(entries => Object.keys(entries).length <= 1200, '词典最多 1200 条')
  .superRefine((entries, ctx) => {
    const slots = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort().join(',')
    for (const [key, text] of Object.entries(entries)) {
      if (slots(key) !== slots(text)) ctx.addIssue({ code: 'custom', path: [key], message: '译文须保留原文的命名占位符' })
    }
  })
export const packageLocalesSchema = z.object({ en: dictionary.optional(), 'zh-CN': dictionary.optional() }).strict()
export type PackageLocales = z.infer<typeof packageLocalesSchema>
export type MessageValues = Readonly<Record<string, string | number>>

/** An absent translation falls back to the author's text. Interpolate user data only after lookup. */
export function packageText(locales: PackageLocales | undefined, locale: keyof PackageLocales, source: string, values?: MessageValues, key = source): string {
  const words = locales?.[locale]
  const template = words && Object.hasOwn(words, key) ? words[key] : source
  return values ? template.replace(/\{(\w+)\}/g, (slot, name: string) => Object.hasOwn(values, name) ? String(values[name]) : slot) : template
}
