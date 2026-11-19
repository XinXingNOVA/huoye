// 表格仅提供承载位置；结构编辑与独立模板编辑器复用。
import { useState } from 'react'
import { Overlay } from '@resource-manager/plugin-api/ui/widgets'
import type { TableColumnMenuProps, TableHeaderProps, TableTools } from '@resource-manager/table-contract'
import { FIELD_TYPES } from './blocks'
import { addOption } from './edit'
import { AddFieldForm, FieldSettings, typeOf } from './field-controls'

function FieldMenu({ column: c, host, rect, onClose }: TableColumnMenuProps) {
  return <Overlay onClose={onClose}><div className="cell-popover field-menu" style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)), top: rect.bottom + 4 }}>
    <FieldSettings key={`${c.field}:${c.def.title}:${c.def.type}`} kind={c.kind} field={c.field} host={host} onDone={onClose} />
  </div></Overlay>
}
function AddFieldHeader({ host, kind }: TableHeaderProps) {
  const [open, setOpen] = useState<DOMRect>()
  return <>
    <button className="th-label" title="新建字段" onClick={e => setOpen(e.currentTarget.getBoundingClientRect())}>＋</button>
    {open && <Overlay onClose={() => setOpen(undefined)}><div className="cell-popover" style={{ left: Math.max(8, open.right - 260), top: open.bottom + 4 }}>
      <AddFieldForm host={host} template={kind.template!} onCreated={() => setOpen(undefined)} />
    </div></Overlay>}
  </>
}
export const templateTableTools: TableTools = {
  match: kind => kind.plugin === 'fields' && kind.template !== undefined,
  columnMenu: { title: c => `${FIELD_TYPES.find(t => t.id === typeOf(c.def))?.title} · 点击改名、改类型、管理选项`, Component: FieldMenu },
  header: { width: 48, Component: AddFieldHeader, emptyHint: '先在表头点 ＋ 新建字段' },
  addOption: (c, option, host) => addOption(host, c.kind.template!, c.field, option)
}
