import { t } from './language'
import type { TextSearch } from '../../shared/query'
import { kindOf } from './ui-registry'
import { kindTitle, fieldTitle } from '../../plugin-api/ui/locale'
export { kindTitle, fieldTitle, enumTitle } from '../../plugin-api/ui/locale'

export function scopeTitle(scope: Pick<TextSearch, 'kind' | 'field'>) {
  if (!scope.kind) return t('search.all')
  const kind = kindOf(scope.kind)
  const name = kind ? kindTitle(kind) : scope.kind
  return scope.field ? `${name} · ${kind ? fieldTitle(kind, scope.field) : scope.field}` : name
}
