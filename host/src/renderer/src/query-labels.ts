import type { LabelKey } from '../../shared/i18n'
import type { FieldDef } from '../../shared/blocks'
import { queryRules, splitConditions, type Query, type QueryRule } from '../../shared/query'
import { displayDate, t } from './language'
import { enumTitle, fieldTitle, kindTitle, scopeTitle } from './schema-labels'
import { kindOf } from './ui-registry'

export const formatValue = (value: unknown, f?: FieldDef): string => {
  if (typeof value === 'boolean') return value ? t('detail.yes') : t('query.no')
  if (typeof value === 'number') {
    if (f?.type === 'date') return displayDate(value, true)
    if (f?.format === 'bytes') return t('section.bytes', { n: value.toLocaleString() })
    if (f?.format === 'duration') return t('section.seconds', { n: value })
    if (f?.format === 'px') return t('section.pixels', { n: value })
  }
  return String(value)
}
export function ruleLabel(r: QueryRule, compact = false): string {
  if ('text' in r) return r.kind ? t('query.searchIn', { scope: scopeTitle(r), text: r.text }) : t('query.searchText', { text: r.text })
  if ('has' in r || 'lacks' in r) {
    const id = 'has' in r ? r.has : r.lacks, kind = kindOf(id)
    return t('has' in r ? 'query.has' : 'query.lacks', { name: kind ? kindTitle(kind) : id })
  }
  const k = kindOf(r.kind), f = k?.fields[r.field]
  const field = k ? fieldTitle(k, r.field) : r.field
  const label = `${k ? kindTitle(k) : r.kind} · ${field}`
  const missing = !k || !f ? t('query.unknown') : ''
  const display = compact ? t('filter.prefix', { label: k && f ? field : label }) : label
  if (r.op === 'subtree') {
    const relation = kindOf(r.tree.kind)
    return t('query.subtree', { field: display, value: r.value }) + (!relation || relation.dormant ? t('query.noRelation') : missing)
  }
  if (r.op === 'empty') return t('query.emptyField', { field: display }) + missing
  if (r.op === 'range') return `${display} ${r.min === undefined ? '≤ ' + formatValue(r.max, f) : r.max === undefined ? '≥ ' + formatValue(r.min, f) : formatValue(r.min, f) + ' — ' + formatValue(r.max, f)}${missing}`
  const values = r.op === 'in' ? r.values : [r.value]
  const labels = values.map(value => {
    if (compact && r.kind === 'file' && r.field === 'ext') return String(value).toUpperCase()
    if (k && f?.type === 'enum') return enumTitle(k, r.field, String(value))
    return formatValue(value, f)
  })
  const operator = compact ? '' : f?.list ? t('filter.contains') : t('filter.is')
  return `${display}${operator} ${labels.join(t('filter.or'))}${missing}`
}
export function sortLabel(q: Query): string {
  const field = !q.sort || q.sort === 'created' ? t('query.created') : scopeTitle(q.sort)
  return `${field} ${q.dir === 'asc' ? t('query.asc') : t('query.desc')}`
}
export function admissionDescription(query: Query) {
  const split = splitConditions(query, kindOf)
  if (!split) return { writes: [], checks: [], blocked: t('drop.blocked') }
  const writes = split.attach.map(id => {
    const kind = kindOf(id)
    return t('drop.attach', { name: kind ? kindTitle(kind) : id })
  })
  for (const condition of split.write) {
    const kind = kindOf(condition.kind)
    if (condition.op === 'empty') {
      writes.push(t('drop.clear', { name: kind ? fieldTitle(kind, condition.field) : condition.field }))
    } else {
      const append = kind?.fields[condition.field]?.list
      writes.push(t(append ? 'drop.add' : 'drop.replace', { rule: ruleLabel(condition) }))
    }
  }
  const checks = queryRules(split.check).map(rule => ruleLabel(rule))
  if (query.ids) checks.push(t('drop.ids'))
  return { writes, checks }
}

/** Keep a validation message in the current language while the draft stays open. */
export class QueryInputError extends Error {
  constructor(readonly key: LabelKey) { super(key) }
}

export function queryErrorText(error: unknown) {
  if (error instanceof QueryInputError) return t(error.key)
  return error instanceof Error ? error.message : String(error)
}
