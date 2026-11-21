import { builtinBlockLocales } from '../../../shared/i18n/builtin-blocks'
import { languageSnapshot } from '../../../shared/i18n/display-locale'
export { languageSnapshot, publishLanguage, useLanguage } from '../../../shared/i18n/display-locale'
import { packageText, type PackageLocales, type MessageValues } from '../../../shared/package-locales'

const dictionaries = new Map<string, PackageLocales>()
export function setPackageLanguages(packages: readonly { manifest: { id: string; locales?: PackageLocales } }[]) {
  dictionaries.clear()
  for (const { manifest } of packages) if (manifest.locales) dictionaries.set(manifest.id, manifest.locales)
}

export function pluginMessages(pluginId: string) {
  return (source: string, values?: MessageValues) => packageText(dictionaries.get(pluginId), languageSnapshot().locale, source, values)
}

export function blockLabel(pluginId: string, key: string, fallback: string) {
  return packageText(dictionaries.get(pluginId) ?? builtinBlockLocales.get(pluginId), languageSnapshot().locale, fallback, undefined, key)
}
