import { kindTitle, fieldTitle, pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { useState } from 'react'
import type { LayoutOptionsProps } from '@resource-manager/plugin-api/ui/contracts'
import { useKinds } from '@resource-manager/plugin-api/ui/data'
import { availableColumns, columnKey, defaultColumns, moveColumn, readColumns, type ColumnRef } from './columns'

const uiText = packageMessages('table')


export function ColumnOptions({options,setOptions}: LayoutOptionsProps) {
  useUiLocale()
  const kinds = useKinds(), [search,setSearch] = useState(''), [dragged,setDragged] = useState<string>()
  const custom = options.columnMode === 'custom', refs = readColumns(options.columns)
  const candidates = availableColumns(kinds), needle = search.trim().toLocaleLowerCase()
  const selected = new Set(refs.map(columnKey))
  const save = (columns: ColumnRef[]) => setOptions({...options,columnMode:'custom',columns})
  const title = (ref:ColumnRef) => {
    const kind = kinds.find(k => k.id === ref.kind), def = kind?.fields[ref.field]
    return def ? `${kindTitle(kind!)} · ${fieldTitle(kind!, ref.field)}${kind!.dormant ? uiText("（只读）") : ''}` : uiText("{kind} · {field}（暂不可用）", { kind: String(ref.kind), field: String(ref.field) })
  }
  const move = (from:number,to:number) => save(moveColumn(refs,from,to))
  return <div className="table-column-options">
    <label className="table-column-mode">{uiText("显示字段")}<select aria-label={uiText("表格列模式")} value={custom?'custom':'auto'} onChange={e => setOptions({...options,columnMode:e.target.value,columns:options.columns ?? defaultColumns.filter(r => candidates.some(c => c.kind.id === r.kind && c.field === r.field))})}>
      <option value="auto">{uiText("默认列")}</option><option value="custom">{uiText("自定义列")}</option>
    </select></label>
    {custom && <>
      <div className="table-column-section"><span>{uiText("已选列 ·")}{' '}{refs.length}</span><button className="link" disabled={!refs.length} onClick={() => save([])}>{uiText("清空选择")}</button></div>
      <div className="table-column-fixed muted">{uiText("素材（固定首列）")}</div>
      <ol className="table-column-selected">{refs.map((ref,i) => <li key={columnKey(ref)} data-column-key={columnKey(ref)}
        onDragOver={e => { if(dragged) { e.preventDefault();e.dataTransfer.dropEffect='move' } }}
        onDrop={e => { if(!dragged)return; e.preventDefault(); e.stopPropagation(); move(refs.findIndex(r => columnKey(r) === dragged),i);setDragged(undefined) }}>
        <span className="table-column-grip" draggable title={uiText("拖动调整列顺序")} onDragStart={e => { setDragged(columnKey(ref));e.stopPropagation();e.dataTransfer.setData('application/x-rm-table-column',columnKey(ref));e.dataTransfer.effectAllowed='move' }} onDragEnd={() => setDragged(undefined)}>⠿</span>
        <span className="table-column-label" title={title(ref)}>{title(ref)}</span>
        <button aria-label={uiText("上移 {value1}", { value1: String(title(ref)) })} disabled={i===0} onClick={() => move(i,i-1)}>↑</button>
        <button aria-label={uiText("下移 {value1}", { value1: String(title(ref)) })} disabled={i===refs.length-1} onClick={() => move(i,i+1)}>↓</button>
        <button aria-label={uiText("隐藏 {value1}", { value1: String(title(ref)) })} onClick={() => save(refs.filter((_,n)=>n!==i))}>×</button>
      </li>)}</ol>
      <input className="field-text" type="search" aria-label={uiText("搜索可选字段")} placeholder={uiText("搜索字段或模板")} value={search} onChange={e=>setSearch(e.target.value)} />
      <div className="table-column-candidates">{kinds.filter(k=>!k.management).map(kind => {
        const entries = candidates.filter(c=>c.kind.id===kind.id && `${kindTitle(kind)} ${fieldTitle(c.kind, c.field)}`.toLocaleLowerCase().includes(needle))
        if(!entries.length)return null
        return <div key={kind.id}><div className="menu-label">{kindTitle(kind)}{kind.dormant?uiText("（只读）"):''}</div>{entries.map(c => {
          const ref={kind:kind.id,field:c.field}, checked=selected.has(columnKey(ref))
          return <label key={c.field}><input type="checkbox" aria-label={`${kindTitle(kind)} · ${fieldTitle(c.kind, c.field)}`} checked={checked} disabled={!checked&&refs.length>=200}
            onChange={()=>save(checked?refs.filter(r=>columnKey(r)!==columnKey(ref)):[...refs,ref])}/><span>{fieldTitle(c.kind, c.field)}</span></label>
        })}</div>
      })}</div>
      {!candidates.some(c=>`${kindTitle(c.kind)} ${fieldTitle(c.kind, c.field)}`.toLocaleLowerCase().includes(needle))&&<span className="muted">{uiText("没有匹配字段")}</span>}
    </>}
  </div>
}
