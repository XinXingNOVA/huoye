import { formatValue, ruleLabel, QueryInputError, queryErrorText } from '../query-labels'
import { enumTitle, fieldTitle, kindTitle } from '../schema-labels'
import { t, useLanguage } from '../language'
import { UiPortal, useUiDocument } from '../../../plugin-api/ui/widgets'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { FieldDef } from '../../../shared/blocks'
import { queryRules, withRules, type Query, type QueryRule } from '../../../shared/query'
import type { UiHost } from '../plugin'
import { useKinds } from '../ui-registry'

/** 原生模态层负责焦点约束；不让编辑条件的按键传给背后的素材列表。 */
export function QueryDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  useLanguage()
  const document = useUiDocument()
  const ref = useRef<HTMLDialogElement>(null), label = useId()
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [document])
  return <UiPortal><dialog ref={ref} className="query-dialog" aria-labelledby={label} onCancel={e => { e.preventDefault(); if (!busy) onClose() }} onKeyDown={e => e.stopPropagation()}>
    <header><h2 id={label}>{title}</h2><button aria-label={t('query.close')} disabled={busy} onClick={onClose}>×</button></header>{children}
  </dialog></UiPortal>
}

export function SortEditor({ value, onChange }: { value: Query; onChange(q: Query): void }) {
  useLanguage()
  const kinds = useKinds().filter(k => !k.management)
  const fields = kinds.flatMap(k => Object.entries(k.fields).filter(([, f]) => f.index && !f.list).map(([id]) => ({ key: JSON.stringify([k.id, id]), kind: k.id, field: id, title: `${kindTitle(k)} · ${fieldTitle(k, id)}` })))
  const selected = !value.sort || value.sort === 'created' ? 'created' : JSON.stringify([value.sort.kind, value.sort.field])
  return <div className="query-sort"><label>{t('query.sortField')}<select aria-label={t('query.sortField')} value={selected} onChange={e => { const field = fields.find(f => f.key === e.target.value); onChange({ ...value, sort: field ? { kind: field.kind, field: field.field } : 'created' }) }}>
    <option value="created">{t('query.created')}</option>{selected !== 'created' && !fields.some(f => f.key === selected) && <option value={selected}>{t('query.oldSort')}</option>}{fields.map(f => <option key={f.key} value={f.key}>{f.title}</option>)}
  </select></label><label>{t('query.order')}<select aria-label={t('query.direction')} value={value.dir ?? 'desc'} onChange={e => onChange({ ...value, dir: e.target.value as Query['dir'] })}><option value="desc">{t('query.desc')}</option><option value="asc">{t('query.asc')}</option></select></label></div>
}

export function RulesEditor({ query, onChange, host, onEditing }: { query: Query; onChange(q: Query): void; host: UiHost; onEditing?(editing: boolean): void }) {
  useLanguage()
  const rules = queryRules(query)
  const [editing, setEditing] = useState<number | 'new'>()
  useEffect(() => { onEditing?.(editing !== undefined); return () => onEditing?.(false) }, [editing, onEditing])
  return <div className="query-rules-editor">
    <p className="muted">{t('query.rulesHelp')}</p>
    {query.ids && <p className="muted">{t('query.withinIds', { count: query.ids.length })}</p>}
    {!rules.length && <p className="query-empty">{t('query.emptyRules')}</p>}
    <ol className="query-rule-list">{rules.map((rule, index) => <li key={index}><button className="query-rule-label" disabled={'op' in rule && rule.op === 'subtree'} title={'op' in rule && rule.op === 'subtree' ? t('query.editTree') : undefined} onClick={() => setEditing(index)}>{ruleLabel(rule)}</button><button aria-label={t('query.removeRule', { n: index + 1 })} onClick={() => { onChange(withRules(query, rules.filter((_, i) => i !== index))); setEditing(undefined) }}>×</button></li>)}</ol>
    {editing === undefined ? <button className="small" onClick={() => setEditing('new')}>{t('query.addRule')}</button> : <RuleComposer key={editing} initial={editing === 'new' ? undefined : rules[editing]} host={host} onCancel={() => setEditing(undefined)} onAdd={next => {
      const updated = [...rules]; if (editing === 'new') updated.push(...next); else updated.splice(editing, 1, ...next)
      onChange(withRules(query, updated)); setEditing(undefined)
    }} />}
  </div>
}

function RuleComposer({ initial, host, onAdd, onCancel }: { initial?: QueryRule; host: UiHost; onAdd(rules: QueryRule[]): void; onCancel(): void }) {
  useLanguage()
  const kinds = useKinds().filter(k => !k.management)
  const initialKind = initial && ('has' in initial ? initial.has : 'lacks' in initial ? initial.lacks : initial.kind)
  const [kind, setKind] = useState(initial && 'text' in initial && !initial.kind ? '$all' : initialKind ?? kinds[0]?.id ?? '')
  const [field, setField] = useState(initial && 'field' in initial ? initial.field ?? '$block' : '$block')
  const [op, setOp] = useState(initial ? 'has' in initial ? 'has' : 'lacks' in initial ? 'lacks' : 'text' in initial ? 'search' : initial.op : 'has')
  const [values, setValues] = useState<(string | number | boolean)[]>(initial && 'op' in initial ? initial.op === 'in' ? initial.values : initial.op === 'eq' ? [initial.value] : [] : [])
  const [input, setInput] = useState(initial && 'text' in initial ? initial.text : '')
  const [min, setMin] = useState(initial && 'op' in initial && initial.op === 'range' ? initial.min : undefined)
  const [max, setMax] = useState(initial && 'op' in initial && initial.op === 'range' ? initial.max : undefined)
  const [error, setError] = useState<unknown>(), [suggestions, setSuggestions] = useState<{ value: string; title: string }[]>([])
  const listId = useId(), k = kinds.find(k => k.id === kind), f = k?.fields[field]
  const fields = Object.entries(k?.fields ?? {}).filter(([, f]) => f.index || f.search)
  const operations = kind === '$all' ? [['search', t('query.searchOp')]] : field === '$block' ? [['has', t('query.hasBlock')], ['lacks', t('query.noBlock')], ...(Object.values(k?.fields ?? {}).some(f => f.search) ? [['search', t('query.searchBlock')]] : [])] : [
    ...(f?.index ? [['eq', f.list ? t('query.contains') : t('query.equal')], ['in', f.list ? t('query.containsAny') : t('query.oneOf')], ...(f.list ? [['all', t('query.containsAll')]] : []), ['empty', t('section.empty')], ...(['number', 'date'].includes(f.type) ? [['range', t('query.range')]] : [])] : []),
    ...(f?.search ? [['search', t('query.searchOp')]] : [])
  ]
  const chooseField = (next: string, def?: FieldDef) => { setField(next); setOp(next === '$block' ? 'has' : def?.index ? 'eq' : 'search'); setValues([]); setInput(''); setMin(undefined); setMax(undefined); setError(undefined) }
  useEffect(() => {
    let alive = true; setSuggestions([])
    if (!f?.index || ['number', 'date', 'boolean'].includes(f.type)) return
    if (f.type === 'enum' && f.options) return
    if (f.options) { setSuggestions(f.options.map(value => ({ value, title: value }))); return }
    void host.core.facet(kind, field).then(async rows => {
      const selected = rows.slice(0, 100)
      if (f.type !== 'ref') return selected.map(r => ({ value: r.value, title: r.value }))
      const items = await host.core.get(selected.map(r => r.value))
      return selected.map(r => ({ value: r.value, title: items.find(v => v.id === r.value) ? host.title(items.find(v => v.id === r.value)!) : r.value }))
    }).then(rows => { if (alive) setSuggestions(rows) }).catch(() => {})
    return () => { alive = false }
  }, [host, kind, field, f])
  const parseValue = (): string | number | boolean => {
    if (f?.type === 'boolean') return input === 'true'
    if (!input.trim()) throw new QueryInputError('query.valueMissing')
    if (f?.type === 'number' || f?.type === 'date') { const n = f.type === 'date' ? new Date(input).getTime() : Number(input); if (!Number.isFinite(n)) throw new QueryInputError('query.invalidNumber'); return n }
    return input.trim()
  }
  const collect = () => [...new Set([...values, ...(input.trim() || (f?.type === 'boolean' && !values.length) ? [parseValue()] : [])])]
  const add = () => {
    try {
      if ((kind !== '$all' && (!k || (field !== '$block' && !f))) || !operations.some(([id]) => id === op)) throw new QueryInputError('query.unavailable')
      if (op === 'has' || op === 'lacks') onAdd([op === 'has' ? { has: kind } : { lacks: kind }])
      else if (op === 'empty') onAdd([{ op: 'empty', kind, field }])
      else if (op === 'search') { if (!input.trim()) throw new QueryInputError('query.needText'); onAdd([{ ...(kind === '$all' ? {} : { kind, ...(field !== '$block' ? { field } : {}) }), text: input.trim() }]) }
      else if (op === 'range') {
        if ((min === undefined && max === undefined) || (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min !== undefined && max !== undefined && min > max)) throw new QueryInputError('query.invalidRange')
        onAdd([{ op: 'range', kind, field, min, max }])
      } else {
        const vs = collect(); if (!vs.length) throw new QueryInputError('query.needValue')
        if (op === 'eq' && vs.length !== 1) throw new QueryInputError('query.singleValue')
        onAdd(op === 'in' ? [{ op: 'in', kind, field, values: vs }] : vs.map(value => ({ op: 'eq', kind, field, value })))
      }
    } catch (e) { setError(e) }
  }
  const dateValue = (n?: number) => n === undefined || !Number.isFinite(n) ? '' : new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const rangeInput = (label: string, value: number | undefined, set: (n: number | undefined) => void) => <label>{label}<input aria-label={label} type={f?.type === 'date' ? 'datetime-local' : 'number'} step="any" value={f?.type === 'date' ? dateValue(value) : value ?? ''} onChange={e => set(e.target.value ? f?.type === 'date' ? new Date(e.target.value).getTime() : Number(e.target.value) : undefined)} /></label>
  return <div className="query-composer">
    <div className="query-fields"><label>{t('query.block')}<select aria-label={t('query.blockInput')} value={kind} onChange={e => { setKind(e.target.value); chooseField('$block'); if (e.target.value === '$all') setOp('search') }}>{!k && kind !== '$all' && <option value={kind}>{t('query.chooseBlock')}</option>}<option value="$all">{t('query.allSearch')}</option>{kinds.map(k => <option key={k.id} value={k.id}>{kindTitle(k)}{k.dormant ? t('search.disabled') : ''}</option>)}</select></label>
      <label>{t('query.field')}<select disabled={kind === '$all'} aria-label={t('query.fieldInput')} value={field} onChange={e => chooseField(e.target.value, k?.fields[e.target.value])}><option value="$block">{t('query.presence')}</option>{fields.map(([id]) => <option value={id} key={id}>{fieldTitle(k!, id)}</option>)}</select></label>
      <label>{t('query.operator')}<select aria-label={t('query.operatorInput')} value={op} onChange={e => { setOp(e.target.value); setError(undefined) }}>{operations.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label></div>
    {op === 'empty' && <p className="muted">{t('query.emptyHelp')}</p>}
    {op === 'range' ? <div className="query-fields">{rangeInput(t('query.min'), min, setMin)}{rangeInput(t('query.max'), max, setMax)}</div> : !['has', 'lacks', 'empty'].includes(op) && <>
      {op !== 'search' && !!values.length && <div className="query-values">{values.map((v, i) => <button key={i} onClick={() => setValues(values.filter((_, j) => j !== i))}>{k && f?.type === 'enum' ? enumTitle(k, field, String(v)) : formatValue(v, f)} ×</button>)}</div>}
      <div className="query-fields"><label>{op === 'search' ? t('query.searchOp') : t(f?.format === 'bytes' ? 'query.valueBytes' : f?.format === 'duration' ? 'query.valueSeconds' : f?.format === 'px' ? 'query.valuePixels' : 'query.value')}
        {f?.type === 'boolean' && op !== 'search' ? <select aria-label={t('query.value')} value={input || 'false'} onChange={e => setInput(e.target.value)}><option value="true">{t('detail.yes')}</option><option value="false">{t('query.no')}</option></select> : k && f?.type === 'enum' && f.options && op !== 'search' ?
          <select aria-label={t('query.value')} value={input} onChange={e => setInput(e.target.value)}>
            <option value="">{t('query.chooseValue')}</option>
            {f.options.map(v => <option key={v} value={v}>{enumTitle(k, field, v)}</option>)}
          </select> : <input aria-label={t('query.value')} list={listId} type={op === 'search' ? 'text' : f?.type === 'date' ? 'datetime-local' : f?.type === 'number' ? 'number' : 'text'} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() } }} />}
        <datalist id={listId}>{suggestions.map(v => <option key={v.value} value={v.value} label={v.title} />)}</datalist></label>
        {['in', 'all'].includes(op) && <button className="small" onClick={() => { try { setValues(collect()); setInput(''); setError(undefined) } catch (e) { setError(e) } }}>{t('query.addValue')}</button>}</div></>}
    {op === 'range' && f?.format && <p className="muted">{t('query.unit', { unit: ({ bytes: t('query.bytes'), duration: t('query.seconds'), px: t('query.pixels'), rating: t('query.rating') } as Record<string, string>)[f.format] ?? f.format })}</p>}
    {error != null && <p className="query-error" role="alert">{queryErrorText(error)}</p>}
    <div className="query-actions"><button onClick={onCancel}>{t('query.cancelRule')}</button><button className="primary" onClick={add}>{t('query.confirmRule')}</button></div>
  </div>
}
