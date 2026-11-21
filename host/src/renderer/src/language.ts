import { translator, type LanguageSnapshot } from '../../shared/i18n'

import { languageSnapshot, publishLanguage } from '../../plugin-api/ui/internal/locale'
export { useLanguage } from '../../plugin-api/ui/internal/locale'

export let t = translator(languageSnapshot().locale)
function receive(next: LanguageSnapshot) {
  if (next.revision <= languageSnapshot().revision) return
  t = translator(next.locale)
  document.documentElement.lang = next.locale
  publishLanguage(next)
}
export function viewTitle(presetId: string | undefined, fallback: string) {
  if (presetId === 'all') return t('common.all')
  if (presetId === 'trash') return t('common.trash')
  return fallback
}
export function displayDate(value: number, withTime = false) {
  return new Intl.DateTimeFormat(languageSnapshot().locale, { year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime && { hour: '2-digit', minute: '2-digit' }) }).format(value)
}
export async function initLanguage() {
  window.bridge.language.onChanged(receive)
  receive(await window.bridge.language.get())
}
export async function setLanguage(value: LanguageSnapshot['preference']) {
  receive(await window.bridge.language.set(value))
}
