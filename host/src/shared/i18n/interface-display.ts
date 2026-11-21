import { interfaceEnglish } from './interface-en'
import { interfaceText, type InterfaceArgs, type InterfaceSource } from './interface-text'
import { languageSnapshot, useLanguage } from './display-locale'

export function uiText<S extends InterfaceSource>(source: S, ...args: InterfaceArgs<S>) {
  return interfaceText(languageSnapshot().locale, source, ...args)
}

export function useUiLocale() { return useLanguage().locale }

/** Only for host-authored metadata. Packages provide their own dictionaries. */
export function hostLabel(source: string): string {
  return languageSnapshot().locale === 'en' && Object.hasOwn(interfaceEnglish, source)
    ? interfaceEnglish[source as InterfaceSource] : source
}
