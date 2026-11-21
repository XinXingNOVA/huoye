import { interfaceEnglish } from './interface-en'
import type { Language } from './index'

type Source = keyof typeof interfaceEnglish
type Slots<S extends string> = S extends `${string}{${infer K}}${infer Rest}` ? K | Slots<Rest> : never
export type InterfaceArgs<S extends Source> = [Slots<S>] extends [never] ? [] : [Record<Slots<S>, string | number>]

export function interfaceText<S extends Source>(language: Language, source: S, ...args: InterfaceArgs<S>) {
  const message: string = language === 'en' ? interfaceEnglish[source] : source
  const values = args[0] as Record<string, string | number> | undefined
  return values ? message.replace(/\{(\w+)\}/g, (slot, key: string) => Object.hasOwn(values, key) ? String(values[key]) : slot) : message
}

export type InterfaceSource = Source
