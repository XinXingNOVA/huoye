import { english } from './en'
import { chinese } from './zh-CN'

export type Language = 'zh-CN' | 'en'
export type LanguagePreference = 'system' | Language
export interface LanguageSnapshot { preference: LanguagePreference; locale: Language; revision: number }
export interface LanguageBridge {
  get(): Promise<LanguageSnapshot>
  set(preference: LanguagePreference): Promise<LanguageSnapshot>
  onChanged(listener: (snapshot: LanguageSnapshot) => void): () => void
}
export type MessageKey = keyof typeof chinese
type Slots<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Slots<Rest> : never
type Args<K extends MessageKey> = [Slots<(typeof chinese)[K]>] extends [never] ? [] : [Record<Slots<(typeof chinese)[K]>, string | number>]

export type LabelKey = { [K in MessageKey]: Slots<(typeof chinese)[K]> extends never ? K : never }[MessageKey]

export function translator(locale: Language) {
  const messages = locale === 'en' ? english : chinese
  return <K extends MessageKey>(key: K, ...args: Args<K>): string => {
    const params: Record<string, string | number> | undefined = args[0]
    return params ? messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name])) : messages[key]
  }
}

export function preferredLanguage(languages: readonly string[]): Language {
  for (const tag of languages) {
    if (/^en(?:-|$)/i.test(tag)) return 'en'
    if (/^zh(?:-|$)/i.test(tag)) return 'zh-CN'
  }
  return 'zh-CN'
}
