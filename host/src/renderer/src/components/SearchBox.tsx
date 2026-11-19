import { acceleratorLabel } from '../widgets'
// 文字查找的范围来自数据定义：新插件、模板、休眠数据沿用同一个入口。
import { useEffect, useState } from 'react'
import type { TextSearch } from '../../../shared/query'
import { searchScopeLabel } from '../../../shared/query'
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
  const kinds = useKinds()
  const searchable = kinds.filter((k) => Object.values(k.fields).some((f) => f.search))
  const selected = kinds.find((k) => k.id === scope.kind)
  const fields = Object.entries(selected?.fields ?? {}).filter(([, f]) => f.search)
  const missingKind = !!scope.kind && !searchable.some((k) => k.id === scope.kind)
  const missingField = !!scope.field && !fields.some(([id]) => id === scope.field)
  const label = searchScopeLabel(scope, kindOf)
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
    <div className={`search-controls${hasCustomScope ? ' scoped' : ''}`} role="search" aria-label="在当前视图中搜索">
      <div className={`search-box${draft ? ' active' : ''}`}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 20 20" />
        </svg>
        <input
          ref={inputRef}
          className="search-input"
          aria-label="搜索内容"
          title={`在${label}中搜索；与当前筛选共同生效`}
          value={draft}
          placeholder={`搜索${hasCustomScope ? ` ${label}` : ''}（${acceleratorLabel('CmdOrCtrl+F')}）`}
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
        {draft && <button className="search-clear" title="清除搜索内容（Esc）" aria-label="清除搜索内容" onClick={clear}>×</button>}
        <select
          className={`select search-scope${hasCustomScope ? ' active' : ''}`}
          aria-label="搜索数据块"
          title={`搜索范围：${label}`}
          value={scope.kind ?? ''}
          onChange={(e) => {
            const kind = e.target.value
            const entries = Object.entries(kindOf(kind)?.fields ?? {}).filter(([, f]) => f.search)
            onScope(kind ? { kind, ...(entries.length === 1 ? { field: entries[0][0] } : {}) } : {})
          }}
        >
          <option value="">全部内容</option>
          {missingKind && <option value={scope.kind}>不可搜索：{selected?.title ?? scope.kind}</option>}
          {[false, true].map((template) => (
            <optgroup key={String(template)} label={template ? '自定义板块' : '数据块'}>
              {searchable.filter((k) => (k.template !== undefined) === template).map((k) => (
                <option key={k.id} value={k.id}>{k.title}{k.dormant ? '（已停用）' : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {scope.kind && (fields.length > 1 || missingField) && (
          <select className="select search-field" aria-label="搜索字段" title={label} value={scope.field ?? ''}
            onChange={(e) => onScope({ kind: scope.kind, ...(e.target.value ? { field: e.target.value } : {}) })}>
            <option value="">全部文字字段</option>
            {missingField && <option value={scope.field}>不可搜索：{selected?.fields[scope.field!]?.title ?? scope.field}</option>}
            {fields.map(([id, f]) => <option key={id} value={id}>{f.title}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}
