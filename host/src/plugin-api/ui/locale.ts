import type { BlockKind } from '../../shared/blocks'
import { blockLabel, useLanguage } from './internal/locale'
export { pluginMessages } from './internal/locale'

/** Subscribe in components that display translated strings. */
export function useLocale() { return useLanguage().locale }

export function kindTitle(kind: BlockKind) {
  return kind.template !== undefined ? kind.title : blockLabel(kind.plugin, `block.${kind.id}`, kind.title)
}

export function fieldTitle(kind: BlockKind, field: string) {
  const title = kind.fields[field]?.title ?? field
  return kind.template !== undefined ? title : blockLabel(kind.plugin, `field.${kind.id}.${field}`, title)
}

export function enumTitle(kind: BlockKind, field: string, value: string) {
  if (kind.template !== undefined || !kind.fields[field]?.options?.includes(value)) return value
  return blockLabel(kind.plugin, `value.${kind.id}.${field}.${value}`, value)
}
