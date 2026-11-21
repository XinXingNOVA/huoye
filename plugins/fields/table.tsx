import { pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
// 表格仅提供承载位置；结构编辑与独立模板编辑器复用。
import { useState } from 'react'
import { IconButton, Popover } from '@resource-manager/plugin-api/ui/kit'
import type { TableColumnMenuProps, TableHeaderProps, TableTools } from '@resource-manager/table-contract'
import { FIELD_TYPES } from './blocks'
import { addOption } from './edit'
import { AddFieldForm, FieldSettings, typeOf } from './field-controls'

const uiText = packageMessages('fields')


function FieldMenu({ column: c, host, rect, onClose }: TableColumnMenuProps) {
  useUiLocale()
  return <Popover anchor={rect} onClose={onClose} className="field-menu" role="dialog" aria-label={uiText("字段设置")}>
    <FieldSettings key={`${c.field}:${c.def.title}:${c.def.type}`} kind={c.kind} field={c.field} host={host} onDone={onClose} />
  </Popover>
}
function AddFieldHeader({ host, kind }: TableHeaderProps) {
  useUiLocale()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return <>
    <IconButton icon="plus" label={uiText("新建字段")} size="sm" aria-haspopup="dialog" aria-expanded={!!anchor} onClick={e => setAnchor(anchor ? null : e.currentTarget)}/>
    {anchor && <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)} role="dialog" aria-label={uiText("新建字段")}>
      <AddFieldForm host={host} template={kind.template!} onCreated={() => setAnchor(null)} />
    </Popover>}
  </>
}
export const templateTableTools: TableTools = {
  match: kind => kind.plugin === 'fields' && kind.template !== undefined,
  columnMenu: { title: c => uiText("{title} · 点击改名、改类型、管理选项", { title: uiText(FIELD_TYPES.find(t => t.id === typeOf(c.def))?.title ?? c.def.type) }), Component: FieldMenu },
  header: { width: 48, Component: AddFieldHeader, get emptyHint() { return uiText("先在表头点 ＋ 新建字段") } },
  addOption: (c, option, host) => addOption(host, c.kind.template!, c.field, option)
}
