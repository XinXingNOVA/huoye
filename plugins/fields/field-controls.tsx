import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import { Button, IconButton, Input } from '@resource-manager/plugin-api/ui/kit'
// 模板编辑器和表格快捷菜单共用；每次操作提交现有事务命令。
import { useRef, useState } from 'react'
import type { BlockKind, FieldDef } from '@resource-manager/plugin-api/blocks'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { acceleratorLabel } from '@resource-manager/plugin-api/ui/widgets'
import { FIELD_TYPES, type FieldType } from './blocks'
import { addField, addOption, changeType, deleteField, deleteOption, renameField, renameOption, type TypeChange } from './edit'
import './table.css'

const uiText = packageMessages('fields')


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
  useUiLocale()
  const [title, setTitle] = useState(''), [type, setType] = useState<FieldType>('text')
  const action = useAction()
  return <form className="add-field" onSubmit={e => {
    e.preventDefault(); if (title.trim()) void action.run(async () => onCreated(await addField(host, template, title.trim(), type)))
  }}>
    <fieldset disabled={action.busy}>
      <Input autoFocus aria-label={uiText("新字段名称")} value={title} placeholder={uiText("字段名称")} onChange={e => setTitle(e.target.value)} />
      <div className="fields-type-options">{FIELD_TYPES.map(t => <Button size="sm" key={t.id} aria-pressed={t.id === type} onClick={() => setType(t.id)}>{uiText(t.title)}</Button>)}</div>
      <Button type="submit" size="sm" disabled={!title.trim()}>{uiText("添加字段")}</Button>
    </fieldset>
    {action.error && <p role="alert">{action.error}</p>}
  </form>
}

export function FieldSettings({ kind, field, host, onDone }: { kind: BlockKind; field: string; host: UiHost; onDone?(): void }) {
  useUiLocale()
  const def = kind.fields[field], template = kind.template!
  const [name, setName] = useState(def.title), [option, setOption] = useState('')
  const [pending, setPending] = useState<{ type: FieldType; change: TypeChange } | { delete: number }>()
  const action = useAction(), current = typeOf(def), choice = current === 'select' || current === 'multi'
  const done = (text: string) => { host.notify(uiText("{text}，可以撤销（{value2}）", { text, value2: String(acceleratorLabel('CmdOrCtrl+Z')) })); setPending(undefined); onDone?.() }
  const rename = () => { if (name.trim() && name.trim() !== def.title) void action.run(async () => { await renameField(host, template, field, name); done(uiText("已修改字段名称")) }) }
  return <div className="field-settings">
    <fieldset disabled={action.busy || kind.dormant}>
      <div className="fields-input-row">
        <Input aria-label={uiText("字段名称")} value={name} onChange={e => setName(e.target.value)} onEnter={rename} />
        <Button size="sm" disabled={!name.trim() || name.trim() === def.title} onClick={rename}>{uiText("保存名称")}</Button>
      </div>
      <div className="menu-label">{uiText("类型")}</div>
      <div className="fields-type-options">{FIELD_TYPES.map(t => <Button size="sm" key={t.id} aria-pressed={t.id === current} data-pending={!!pending && 'type' in pending && pending.type === t.id || undefined}
        onClick={() => t.id === current ? setPending(undefined) : void action.run(async () => setPending({ type: t.id, change: await changeType(host, template, field, t.id, true) }))}>{uiText(t.title)}</Button>)}</div>
      {pending && 'type' in pending && <div className="menu-confirm"><span>{pending.change.total === 0 ? uiText("还没有值") : pending.change.cleared ? uiText("{total} 项有值，其中 {cleared} 项转换不了，会清空", { total: String(pending.change.total), cleared: String(pending.change.cleared) }) : uiText("{total} 项有值，都能转换", { total: String(pending.change.total) })}</span>
        <Button size="sm" onClick={() => void action.run(async () => { await changeType(host, template, field, pending.type); done(uiText("已修改字段类型")) })}>{uiText("确认更改")}</Button></div>}
      {choice && <>
        <div className="menu-label">{uiText("选项（改成已有选项会合并）")}</div>
        {(def.options ?? []).map(o => <OptionRow key={o} option={o} host={host} template={template} field={field} />)}
        <form className="fields-input-row" onSubmit={e => { e.preventDefault(); if (option.trim()) void action.run(async () => { await addOption(host, template, field, option); setOption('') }) }}>
          <Input aria-label={uiText("新选项")} placeholder={uiText("新选项")} value={option} onChange={e => setOption(e.target.value)} />
          <Button type="submit" size="sm" disabled={!option.trim()}>{uiText("添加选项")}</Button>
        </form>
      </>}
      <div className="menu-foot">{pending && 'delete' in pending ? <div className="menu-confirm">
        <span>{pending.delete ? uiText("{delete} 项的值会清空", { delete: String(pending.delete) }) : uiText("还没有值")}</span>
        <Button size="sm" variant="danger" onClick={() => void action.run(async () => { await deleteField(host, template, field); done(uiText("已删除字段")) })}>{uiText("确认删除")}</Button>
      </div> : <Button size="sm" variant="danger" onClick={() => void action.run(async () => setPending({ delete: (await deleteField(host, template, field, true)).cleared }))}>{uiText("删除字段")}</Button>}</div>
    </fieldset>
    {action.error && <p role="alert">{action.error}</p>}
  </div>
}
function OptionRow({ option, host, template, field }: { option: string; host: UiHost; template: string; field: string }) {
  useUiLocale()
  const [text, setText] = useState(option), action = useAction()
  const rename = () => { if (text.trim() && text.trim() !== option) void action.run(() => renameOption(host, template, field, option, text.trim())) }
  return <div>
    <div className="option-row">
      <Input aria-label={uiText("选项 {option}", { option })} disabled={action.busy} value={text} onChange={e => setText(e.target.value)} onEnter={rename} />
      <Button size="sm" disabled={action.busy || !text.trim() || text.trim() === option} onClick={rename}>{uiText("改名")}</Button>
      <IconButton icon="close" size="sm" label={uiText("删除选项 {option}", { option })} disabled={action.busy} onClick={() => void action.run(async () => {
        const { cleared } = await deleteOption(host, template, field, option)
        host.notify(uiText("已删除选项「{option}」{value2}，可以撤销（{value3}）", { option, value2: String(cleared ? uiText("，{cleared} 项上去掉了这个值", { cleared }) : ''), value3: String(acceleratorLabel('CmdOrCtrl+Z')) }))
      })}/>
    </div>{action.error && <p role="alert">{action.error}</p>}
  </div>
}
