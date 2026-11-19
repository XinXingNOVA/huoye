// 模板编辑器和表格快捷菜单共用；每次操作提交现有事务命令。
import { useRef, useState } from 'react'
import type { BlockKind, FieldDef } from '@resource-manager/plugin-api/blocks'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { acceleratorLabel, isEnter } from '@resource-manager/plugin-api/ui/widgets'
import { FIELD_TYPES, type FieldType } from './blocks'
import { addField, addOption, changeType, deleteField, deleteOption, renameField, renameOption, type TypeChange } from './edit'
import './table.css'

export function useAction() {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  return { busy, error, run }
}
export function typeOf(def: FieldDef): FieldType {
  if (def.format === 'rating') return 'rating'
  if (def.format === 'url') return 'url'
  if (def.type === 'enum') return def.list ? 'multi' : 'select'
  if (def.type === 'boolean') return 'checkbox'
  if (def.type === 'longtext' || def.type === 'number' || def.type === 'date') return def.type
  return 'text'
}

export function AddFieldForm({ host, template, onCreated }: { host: UiHost; template: string; onCreated(id: string): void }) {
  const [title, setTitle] = useState(''), [type, setType] = useState<FieldType>('text')
  const action = useAction()
  return <form className="add-field" onSubmit={e => {
    e.preventDefault(); if (title.trim()) void action.run(async () => onCreated(await addField(host, template, title.trim(), type)))
  }}>
    <fieldset disabled={action.busy}>
      <input className="field-text" autoFocus aria-label="新字段名称" value={title} placeholder="字段名称" onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !isEnter(e)) e.preventDefault() }} />
      <div className="field-options">{FIELD_TYPES.map(t => <button type="button" key={t.id} className={`field-option${t.id === type ? ' active' : ''}`} onClick={() => setType(t.id)}>{t.title}</button>)}</div>
      <button className="small" disabled={!title.trim()}>添加字段</button>
    </fieldset>
    {action.error && <p role="alert">{action.error}</p>}
  </form>
}

export function FieldSettings({ kind, field, host, onDone }: { kind: BlockKind; field: string; host: UiHost; onDone?(): void }) {
  const def = kind.fields[field], template = kind.template!
  const [name, setName] = useState(def.title), [option, setOption] = useState('')
  const [pending, setPending] = useState<{ type: FieldType; change: TypeChange } | { delete: number }>()
  const action = useAction(), current = typeOf(def), choice = current === 'select' || current === 'multi'
  const done = (text: string) => { host.notify(`${text}，可以撤销（${acceleratorLabel('CmdOrCtrl+Z')}）`); setPending(undefined); onDone?.() }
  const rename = () => { if (name.trim() && name.trim() !== def.title) void action.run(async () => { await renameField(host, template, field, name); done('已修改字段名称') }) }
  return <div className="field-settings">
    <fieldset disabled={action.busy || kind.dormant}>
      <div className="fields-input-row">
        <input className="field-text" aria-label="字段名称" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (isEnter(e)) { e.preventDefault(); rename() } }} />
        <button className="small" disabled={!name.trim() || name.trim() === def.title} onClick={rename}>保存名称</button>
      </div>
      <div className="menu-label">类型</div>
      <div className="field-options">{FIELD_TYPES.map(t => <button key={t.id} className={`field-option${t.id === current ? ' active' : pending && 'type' in pending && pending.type === t.id ? ' pending' : ''}`}
        onClick={() => t.id === current ? setPending(undefined) : void action.run(async () => setPending({ type: t.id, change: await changeType(host, template, field, t.id, true) }))}>{t.title}</button>)}</div>
      {pending && 'type' in pending && <div className="menu-confirm"><span>{pending.change.total === 0 ? '还没有值' : pending.change.cleared ? `${pending.change.total} 项有值，其中 ${pending.change.cleared} 项转换不了，会清空` : `${pending.change.total} 项有值，都能转换`}</span>
        <button className="small" onClick={() => void action.run(async () => { await changeType(host, template, field, pending.type); done('已修改字段类型') })}>确认更改</button></div>}
      {choice && <>
        <div className="menu-label">选项（改成已有选项会合并）</div>
        {(def.options ?? []).map(o => <OptionRow key={o} option={o} host={host} template={template} field={field} />)}
        <form className="fields-input-row" onSubmit={e => { e.preventDefault(); if (option.trim()) void action.run(async () => { await addOption(host, template, field, option); setOption('') }) }}>
          <input className="field-text" aria-label="新选项" placeholder="新选项" value={option} onChange={e => setOption(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !isEnter(e)) e.preventDefault() }} />
          <button className="small" disabled={!option.trim()}>添加选项</button>
        </form>
      </>}
      <div className="menu-foot">{pending && 'delete' in pending ? <div className="menu-confirm">
        <span>{pending.delete ? `${pending.delete} 项的值会清空` : '还没有值'}</span>
        <button className="small danger" onClick={() => void action.run(async () => { await deleteField(host, template, field); done('已删除字段') })}>确认删除</button>
      </div> : <button className="small danger" onClick={() => void action.run(async () => setPending({ delete: (await deleteField(host, template, field, true)).cleared }))}>删除字段</button>}</div>
    </fieldset>
    {action.error && <p role="alert">{action.error}</p>}
  </div>
}
function OptionRow({ option, host, template, field }: { option: string; host: UiHost; template: string; field: string }) {
  const [text, setText] = useState(option), action = useAction()
  const rename = () => { if (text.trim() && text.trim() !== option) void action.run(() => renameOption(host, template, field, option, text.trim())) }
  return <div>
    <div className="option-row">
      <input className="field-text" aria-label={`选项 ${option}`} disabled={action.busy} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (isEnter(e)) { e.preventDefault(); rename() } }} />
      <button className="small" disabled={action.busy || !text.trim() || text.trim() === option} onClick={rename}>改名</button>
      <button className="nav-x" aria-label={`删除选项 ${option}`} disabled={action.busy} onClick={() => void action.run(async () => {
        const { cleared } = await deleteOption(host, template, field, option)
        host.notify(`已删除选项「${option}」${cleared ? `，${cleared} 项上去掉了这个值` : ''}，可以撤销（${acceleratorLabel('CmdOrCtrl+Z')}）`)
      })}>×</button>
    </div>{action.error && <p role="alert">{action.error}</p>}
  </div>
}
