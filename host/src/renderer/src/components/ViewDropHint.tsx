import type { Query } from '../../../shared/query'
import { t, useLanguage } from '../language'
import { admissionDescription } from '../query-labels'

/** 中央视图与导航入口复用同一份写入／检查说明。 */
export function ViewDropHint({ query, title, internal }: { query?: Query; title: string; internal: boolean }) {
  useLanguage()
  const hint = query && admissionDescription(query)
  return <div className="drop-hint">
    <strong>{hint?.blocked ?? (query ? t('drop.into', { title }) : t(internal ? 'drop.noRules' : 'drop.import'))}</strong>
    {hint?.writes.map((s, i) => <p key={`w${i}`}>{t('drop.will', { rule: s })}</p>)}
    {!!hint?.checks.length && <p className="drop-checks">{t('drop.requires', { rules: hint.checks.join(t('query.separator')) })}</p>}
    <small>{t(internal ? 'drop.internalHint' : 'drop.externalHint')}</small>
  </div>
}
