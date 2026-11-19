import { useId, useState } from 'react'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import { useEntityState, useKinds } from '@resource-manager/plugin-api/ui/data'
import { isEnter } from '@resource-manager/plugin-api/ui/widgets'
import { renameTemplate } from './edit'
import { AddFieldForm, FieldSettings, typeOf, useAction } from './field-controls'
import { FIELD_TYPES } from './blocks'
import './template-editor.css'

export const editTemplate = (host: UiHost, template: string) => host.showDialog(close => <TemplateEditor host={host} template={template} close={close} />)
function TemplateEditor({ host, template, close }: { host: UiHost; template: string; close(): void }) {
  const record = useEntityState(template), kinds = useKinds(), titleId = useId()
  const kind = kinds.find(k => k.template === template && k.plugin === 'fields')
  const [editing, setEditing] = useState<string>(), [adding, setAdding] = useState(false)
  const unavailable = record.status === 'missing' || (record.view && (!record.view.blocks.template || record.view.deletedAt !== null))
  return <section className="fields-template-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header><h2 id={titleId}>编辑模板</h2><button className="small" aria-label="关闭模板编辑器" onClick={close}>完成</button></header>
    {unavailable ? <p role="status">模板已不存在。</p> : record.status === 'error' ? <p role="alert">{record.error}</p> : !kind || !record.view ? <p>正在读取模板…</p> : <>
      <TemplateName key={kind.title} host={host} template={template} title={kind.title} disabled={!!kind.dormant} />
      <div className="fields-editor-toolbar"><span>字段 · {Object.keys(kind.fields).length}</span><button className="small" disabled={kind.dormant} onClick={() => { setAdding(v => !v); setEditing(undefined) }}>＋ 新增字段</button></div>
      {adding && <AddFieldForm host={host} template={template} onCreated={id => { setAdding(false); setEditing(id) }} />}
      <div className="fields-editor-list">{Object.entries(kind.fields).map(([id, def]) => <div className="fields-editor-item" key={id}>
        <button className="fields-editor-field" aria-expanded={editing === id} onClick={() => { setEditing(editing === id ? undefined : id); setAdding(false) }}>
          <span>{def.title}</span><span className="muted">{FIELD_TYPES.find(t => t.id === typeOf(def))?.title} {editing === id ? '▴' : '▾'}</span>
        </button>
        {editing === id && <FieldSettings key={`${id}:${def.title}:${def.type}`} host={host} kind={kind} field={id} />}
      </div>)}</div>
      {!Object.keys(kind.fields).length && !adding && <p className="muted">还没有字段，点击“新增字段”开始。</p>}
    </>}
  </section>
}
function TemplateName({ host, template, title, disabled }: { host: UiHost; template: string; title: string; disabled: boolean }) {
  const [name, setName] = useState(title), action = useAction()
  return <form onSubmit={e => { e.preventDefault(); if (name.trim() && name.trim() !== title) void action.run(() => renameTemplate(host, template, name)) }}>
    <label className="fields-input-row"><span>名称</span><input className="field-text" aria-label="模板名称" value={name} disabled={disabled || action.busy} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !isEnter(e)) e.preventDefault() }} />
      <button className="small" disabled={disabled || action.busy || !name.trim() || name.trim() === title}>保存名称</button>
    </label>{action.error && <p role="alert">{action.error}</p>}
  </form>
}
