import type { Library } from './library'
import type { ImportSettingsInput } from '../shared/import-settings'

export type ImportPolicy = Pick<ImportSettingsInput, 'collect' | 'spaces'>

/** 单次操作读取；不跨扫描缓存，以免排队期间的设置变化被忽略。 */
export function readImportPolicy(lib: Library): ImportPolicy {
  const raw = lib.db.prepare("SELECT value FROM main.config WHERE key='imports.v1'").pluck().get() as string | undefined
  if (!raw) return { collect: true, spaces: [] }
  const value = JSON.parse(raw)
  return { collect: value.collect, spaces: value.spaces }
}
