import { useSyncExternalStore } from 'react'
import type { LanguageSnapshot } from './index'

let current: LanguageSnapshot = { preference: 'system', locale: 'zh-CN', revision: -1 }
const listeners = new Set<() => void>()
export const subscribeLanguage = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const languageSnapshot = () => current
export const useLanguage = () => useSyncExternalStore(subscribeLanguage, languageSnapshot)
export function publishLanguage(next: LanguageSnapshot) {
  current = next
  listeners.forEach(fn => fn())
}
