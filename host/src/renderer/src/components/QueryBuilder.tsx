import { UiPortal, useUiDocument } from '../../../plugin-api/ui/widgets'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { FieldDef } from '../../../shared/blocks'
import { describeCondition, queryRules, withRules, type Query, type QueryRule } from '../../../shared/query'
import type { UiHost } from '../plugin'
import { kindOf, useKinds } from '../ui-registry'

/** 原生模态层负责焦点约束；不让编辑条件的按键传给背后的素材列表。 */
export function QueryDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  const document = useUiDocument()
  const ref = useRef<HTMLDialogElement>(null), label = useId()
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [document])
  return <UiPortal><dialog ref={ref} className="query-dialog" aria-labelledby={label} onCancel={e => { e.preventDefault(); if (!busy) onClose() }} onKeyDown={e => e.stopPropagation()}>
    <header><h2 id={label}>{title}</h2><button aria-label="关闭" disabled={busy} onClick={onClose}>×</button></header>{children}
  </dialog></UiPortal>
}

const formatValue = (value: unknown, f?: FieldDef): string => {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') {
    if (f?.type === 'date') return new Date(value).toLocaleString()
    if (f?.format === 'bytes') return `${value.toLocaleString()} 字节`
    if (f?.format === 'duration') return `${value} 秒`
    if (f?.format === 'px') return `${value} 像素`
  }
  return String(value)
}
export function ruleLabel(r: QueryRule, compact = false): string {
  if (!('op' in r)) return describeCondition(r, kindOf)
  const k = kindOf(r.kind), f = k?.fields[r.field], label = `${k?.title ?? r.kind} · ${f?.title ?? r.field}`
  const missing = !k || !f ? '（定义不可用）' : ''
  const short = k && f ? f.title : label
  const display = compact ? short + '：' : label
  if (r.op === 'subtree') return `${display}${r.value}（含下级）${!kindOf(r.tree.kind) || kindOf(r.tree.kind)?.dormant ? '（关系不可用）' : missing}`
  if (r.op === 'empty') return `${display}未填写${missing}`
  if (r.op === 'range') return `${display} ${r.min === undefined ? '≤ ' + formatValue(r.max, f) : r.max === undefined ? '≥ ' + formatValue(r.min, f) : formatValue(r.min, f) + ' — ' + formatValue(r.max, f)}${missing}`
  const values = r.op === 'in' ? r.values : [r.value]
  return `${display}${compact ? '' : f?.list ? '包含' : '为'} ${values.map(v => r.kind === 'file' && r.field === 'ext' && compact ? String(v).toUpperCase() : formatValue(v, f)).join(' 或 ')}${missing}`
}
export function sortLabel(q: Query): string {
  const field = !q.sort || q.sort === 'created' ? '收录时间' : `${kindOf(q.sort.kind)?.title ?? q.sort.kind} · ${kindOf(q.sort.kind)?.fields[q.sort.field]?.title ?? q.sort.field}`
  return `${field} ${q.dir === 'asc' ? '升序' : '降序'}`
}
export function SortEditor({ value, onChange }: { value: Query; onChange(q: Query): void }) {
  const kinds = useKinds().filter(k => !k.management)
  const fields = kinds.flatMap(k => Object.entries(k.fields).filter(([, f]) => f.index && !f.list).map(([id, f]) => ({ key: JSON.stringify([k.id, id]), kind: k.id, field: id, title: `${k.title} · ${f.title}` })))
  const selected = !value.sort || value.sort === 'created' ? 'created' : JSON.stringify([value.sort.kind, value.sort.field])
  return <div className="query-sort"><label>排序字段<select aria-label="排序字段" value={selected} onChange={e => { const field = fields.find(f => f.key === e.target.value); onChange({ ...value, sort: field ? { kind: field.kind, field: field.field } : 'created' }) }}>
    <option value="created">收录时间</option>{selected !== 'created' && !fields.some(f => f.key === selected) && <option value={selected}>原排序字段不可用（暂按收录时间）</option>}{fields.map(f => <option key={f.key} value={f.key}>{f.title}</option>)}
  </select></label><label>顺序<select aria-label="排序顺序" value={value.dir ?? 'desc'} onChange={e => onChange({ ...value, dir: e.target.value as Query['dir'] })}><option value="desc">降序</option><option value="asc">升序</option></select></label></div>
}

export function RulesEditor({ query, onChange, host, onEditing }: { query: Query; onChange(q: Query): void; host: UiHost; onEditing?(editing: boolean): void }) {
  const rules = queryRules(query)
  const [editing, setEditing] = useState<number | 'new'>()
  useEffect(() => { onEditing?.(editing !== undefined); return () => onEditing?.(false) }, [editing, onEditing])
  return <div className="query-rules-editor">
    <p className="muted">同时满足以下条件；同一条件中的多个候选值可以取“任一”。</p>
    {query.ids && <p className="muted">还限定在 {query.ids.length} 个指定素材内。此范围会保留。</p>}
    {!rules.length && <p className="query-empty">没有条件，显示此范围内的全部素材。</p>}
    <ol className="query-rule-list">{rules.map((rule, index) => <li key={index}><button className="query-rule-label" disabled={'op' in rule && rule.op === 'subtree'} title={'op' in rule && rule.op === 'subtree' ? '在层级工具中调整此条件；也可在这里删除' : undefined} onClick={() => setEditing(index)}>{ruleLabel(rule)}</button><button aria-label={`删除条件 ${index + 1}`} onClick={() => { onChange(withRules(query, rules.filter((_, i) => i !== index))); setEditing(undefined) }}>×</button></li>)}</ol>
    {editing === undefined ? <button className="small" onClick={() => setEditing('new')}>＋添加条件</button> : <RuleComposer key={editing} initial={editing === 'new' ? undefined : rules[editing]} host={host} onCancel={() => setEditing(undefined)} onAdd={next => {
      const updated = [...rules]; if (editing === 'new') updated.push(...next); else updated.splice(editing, 1, ...next)
      onChange(withRules(query, updated)); setEditing(undefined)
    }} />}
  </div>
}

function RuleComposer({ initial, host, onAdd, onCancel }: { initial?: QueryRule; host: UiHost; onAdd(rules: QueryRule[]): void; onCancel(): void }) {
  const kinds = useKinds().filter(k => !k.management)
  const initialKind = initial && ('has' in initial ? initial.has : 'lacks' in initial ? initial.lacks : initial.kind)
  const [kind, setKind] = useState(initial && 'text' in initial && !initial.kind ? '$all' : initialKind ?? kinds[0]?.id ?? '')
  const [field, setField] = useState(initial && 'field' in initial ? initial.field ?? '$block' : '$block')
  const [op, setOp] = useState(initial ? 'has' in initial ? 'has' : 'lacks' in initial ? 'lacks' : 'text' in initial ? 'search' : initial.op : 'has')
  const [values, setValues] = useState<(string | number | boolean)[]>(initial && 'op' in initial ? initial.op === 'in' ? initial.values : initial.op === 'eq' ? [initial.value] : [] : [])
  const [input, setInput] = useState(initial && 'text' in initial ? initial.text : '')
  const [min, setMin] = useState(initial && 'op' in initial && initial.op === 'range' ? initial.min : undefined)
  const [max, setMax] = useState(initial && 'op' in initial && initial.op === 'range' ? initial.max : undefined)
  const [error, setError] = useState(''), [suggestions, setSuggestions] = useState<{ value: string; title: string }[]>([])
  const listId = useId(), k = kinds.find(k => k.id === kind), f = k?.fields[field]
  const fields = Object.entries(k?.fields ?? {}).filter(([, f]) => f.index || f.search)
  const operations = kind === '$all' ? [['search', '搜索文字']] : field === '$block' ? [['has', '有此数据块'], ['lacks', '没有此数据块'], ...(Object.values(k?.fields ?? {}).some(f => f.search) ? [['search', '搜索此数据块']] : [])] : [
    ...(f?.index ? [['eq', f.list ? '包含' : '等于'], ['in', f.list ? '包含任一值' : '是任一值'], ...(f.list ? [['all', '包含所有值']] : []), ['empty', '未填写'], ...(['number', 'date'].includes(f.type) ? [['range', '范围']] : [])] : []),
    ...(f?.search ? [['search', '搜索文字']] : [])
  ]
  const chooseField = (next: string, def?: FieldDef) => { setField(next); setOp(next === '$block' ? 'has' : def?.index ? 'eq' : 'search'); setValues([]); setInput(''); setMin(undefined); setMax(undefined); setError('') }
  useEffect(() => {
    let alive = true; setSuggestions([])
    if (!f?.index || ['number', 'date', 'boolean'].includes(f.type)) return
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
    if (!input.trim()) throw new Error('请填写条件值')
    if (f?.type === 'number' || f?.type === 'date') { const n = f.type === 'date' ? new Date(input).getTime() : Number(input); if (!Number.isFinite(n)) throw new Error('请输入有效的数值或日期'); return n }
    return input.trim()
  }
  const collect = () => [...new Set([...values, ...(input.trim() || (f?.type === 'boolean' && !values.length) ? [parseValue()] : [])])]
  const add = () => {
    try {
      if ((kind !== '$all' && (!k || (field !== '$block' && !f))) || !operations.some(([id]) => id === op)) throw new Error('请重新选择可用的数据块和字段')
      if (op === 'has' || op === 'lacks') onAdd([op === 'has' ? { has: kind } : { lacks: kind }])
      else if (op === 'empty') onAdd([{ op: 'empty', kind, field }])
      else if (op === 'search') { if (!input.trim()) throw new Error('请输入搜索文字'); onAdd([{ ...(kind === '$all' ? {} : { kind, ...(field !== '$block' ? { field } : {}) }), text: input.trim() }]) }
      else if (op === 'range') {
        if ((min === undefined && max === undefined) || (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min !== undefined && max !== undefined && min > max)) throw new Error('请填写有效范围，下限不能大于上限')
        onAdd([{ op: 'range', kind, field, min, max }])
      } else {
        const vs = collect(); if (!vs.length) throw new Error('请添加至少一个值')
        if (op === 'eq' && vs.length !== 1) throw new Error('等于条件只能选择一个值；多值请用“任一”或“所有”')
        onAdd(op === 'in' ? [{ op: 'in', kind, field, values: vs }] : vs.map(value => ({ op: 'eq', kind, field, value })))
      }
    } catch (e) { setError((e as Error).message) }
  }
  const dateValue = (n?: number) => n === undefined || !Number.isFinite(n) ? '' : new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const rangeInput = (label: string, value: number | undefined, set: (n: number | undefined) => void) => <label>{label}<input aria-label={label} type={f?.type === 'date' ? 'datetime-local' : 'number'} step="any" value={f?.type === 'date' ? dateValue(value) : value ?? ''} onChange={e => set(e.target.value ? f?.type === 'date' ? new Date(e.target.value).getTime() : Number(e.target.value) : undefined)} /></label>
  return <div className="query-composer">
    <div className="query-fields"><label>数据块<select aria-label="条件数据块" value={kind} onChange={e => { setKind(e.target.value); chooseField('$block'); if (e.target.value === '$all') setOp('search') }}>{!k && kind !== '$all' && <option value={kind}>请选择数据块</option>}<option value="$all">全部内容（搜索）</option>{kinds.map(k => <option key={k.id} value={k.id}>{k.title}{k.dormant ? '（已停用）' : ''}</option>)}</select></label>
      <label>字段<select disabled={kind === '$all'} aria-label="条件字段" value={field} onChange={e => chooseField(e.target.value, k?.fields[e.target.value])}><option value="$block">数据块是否存在</option>{fields.map(([id, f]) => <option value={id} key={id}>{f.title}</option>)}</select></label>
      <label>条件<select aria-label="条件运算" value={op} onChange={e => { setOp(e.target.value); setError('') }}>{operations.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label></div>
    {op === 'empty' && <p className="muted">包括没有此数据块或字段没有值的素材。只查已有数据块时，再添加“有此数据块”。</p>}
    {op === 'range' ? <div className="query-fields">{rangeInput('下限（含）', min, setMin)}{rangeInput('上限（含）', max, setMax)}</div> : !['has', 'lacks', 'empty'].includes(op) && <>
      {op !== 'search' && !!values.length && <div className="query-values">{values.map((v, i) => <button key={i} onClick={() => setValues(values.filter((_, j) => j !== i))}>{formatValue(v, f)} ×</button>)}</div>}
      <div className="query-fields"><label>{op === 'search' ? '搜索文字' : `条件值${f?.format === 'bytes' ? '（字节）' : f?.format === 'duration' ? '（秒）' : f?.format === 'px' ? '（像素）' : ''}`}
        {f?.type === 'boolean' && op !== 'search' ? <select aria-label="条件值" value={input || 'false'} onChange={e => setInput(e.target.value)}><option value="true">是</option><option value="false">否</option></select> : <input aria-label="条件值" list={listId} type={op === 'search' ? 'text' : f?.type === 'date' ? 'datetime-local' : f?.type === 'number' ? 'number' : 'text'} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() } }} />}
        <datalist id={listId}>{suggestions.map(v => <option key={v.value} value={v.value} label={v.title} />)}</datalist></label>
        {['in', 'all'].includes(op) && <button className="small" onClick={() => { try { setValues(collect()); setInput(''); setError('') } catch (e) { setError((e as Error).message) } }}>添加值</button>}</div></>}
    {op === 'range' && f?.format && <p className="muted">单位：{({ bytes: '字节', duration: '秒', px: '像素', rating: '评分' } as Record<string, string>)[f.format] ?? f.format}</p>}
    {error && <p className="query-error" role="alert">{error}</p>}
    <div className="query-actions"><button onClick={onCancel}>取消条件</button><button className="primary" onClick={add}>确定条件</button></div>
  </div>
}
