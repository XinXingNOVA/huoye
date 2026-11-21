import { t, useLanguage } from '../language'
import { acceleratorLabel } from '../widgets'
// 文字查找的范围来自数据定义：新插件、模板、休眠数据沿用同一个入口。
import { useEffect, useState } from 'react'
import type { TextSearch } from '../../../shared/query'
import { fieldTitle, kindTitle, scopeTitle } from '../schema-labels'
import { kindOf, useKinds } from '../ui-registry'
import { isEnter } from '../widgets'

export type SearchScope = Pick<TextSearch, 'kind' | 'field'>

export function SearchBox({ value, scope, onChange, onScope, inputRef }: {
  value: string
  scope: SearchScope
  onChange(v: string): void
  onScope(s: SearchScope): void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  useLanguage()
  const kinds = useKinds()
  const searchable = kinds.filter((k) => Object.values(k.fields).some((f) => f.search))
  const selected = kinds.find((k) => k.id === scope.kind)
  const fields = Object.entries(selected?.fields ?? {}).filter(([, f]) => f.search)
  const missingKind = !!scope.kind && !searchable.some((k) => k.id === scope.kind)
  const missingField = !!scope.field && !fields.some(([id]) => id === scope.field)
  const label = scopeTitle(scope)
  const [draft, setDraft] = useState(value)
  const [composing, setComposing] = useState(false)
  // 外部清空（另存为视图），以及中文输入法组合结束后的防抖。
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (composing || draft === value) return
    const timer = setTimeout(() => onChange(draft), 250)
    return () => clearTimeout(timer)
  }, [draft, value, composing, onChange])
  const clear = () => {
    setDraft('')
    onChange('')
  }
  const hasCustomScope = !!scope.kind
  return (
    <div className={`search-controls${hasCustomScope ? ' scoped' : ''}`} role="search" aria-label={t('search.within')}>
      <div className={`search-box${draft ? ' active' : ''}`}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 20 20" />
        </svg>
        <input
          ref={inputRef}
          className="search-input"
          aria-label={t('search.label')}
          title={t('search.tooltip', { scope: label })}
          value={draft}
          placeholder={t('search.placeholder', { scope: hasCustomScope ? ' ' + label : '', shortcut: acceleratorLabel('CmdOrCtrl+F') })}
          spellCheck={false}
          onChange={(e) => {
            if (!e.target.value && !composing && !(e.nativeEvent as InputEvent).isComposing) clear()
            else setDraft(e.target.value)
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={e => {
            setComposing(false)
            if (!e.currentTarget.value) clear()
          }}
          onKeyDown={(e) => {
            if (isEnter(e)) onChange(draft)
            else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.stopPropagation()
              if (draft) clear()
              else e.currentTarget.blur()
            }
          }}
        />
        {draft && <button className="search-clear" title={t('search.clearHint')} aria-label={t('search.clear')} onClick={clear}>×</button>}
        <select
          className={`select search-scope${hasCustomScope ? ' active' : ''}`}
          aria-label={t('search.blocks')}
          title={t('search.scope', { scope: label })}
          value={scope.kind ?? ''}
          onChange={(e) => {
            const kind = e.target.value
            const entries = Object.entries(kindOf(kind)?.fields ?? {}).filter(([, f]) => f.search)
            onScope(kind ? { kind, ...(entries.length === 1 ? { field: entries[0][0] } : {}) } : {})
          }}
        >
          <option value="">{t('search.all')}</option>
          {missingKind && <option value={scope.kind}>{t('search.unavailable')}{selected ? kindTitle(selected) : scope.kind}</option>}
          {[false, true].map((template) => (
            <optgroup key={String(template)} label={template ? t('search.custom') : t('search.standard')}>
              {searchable.filter((k) => (k.template !== undefined) === template).map((k) => (
                <option key={k.id} value={k.id}>{kindTitle(k)}{k.dormant ? t('search.disabled') : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {scope.kind && (fields.length > 1 || missingField) && (
          <select className="select search-field" aria-label={t('search.field')} title={label} value={scope.field ?? ''}
            onChange={(e) => onScope({ kind: scope.kind, ...(e.target.value ? { field: e.target.value } : {}) })}>
            <option value="">{t('search.fields')}</option>
            {missingField && <option value={scope.field}>{t('search.unavailable')}{selected ? fieldTitle(selected, scope.field!) : scope.field}</option>}
            {fields.map(([id]) => <option key={id} value={id}>{fieldTitle(selected!, id)}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}
