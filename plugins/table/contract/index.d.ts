// 表格公开的协作契约。其他插件只依赖这里的类型，不导入表格的组件或实现。
import type { FC } from 'react'
import type { BlockKind, FieldDef } from '@resource-manager/plugin-api/blocks'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'

export interface TableColumn {
  kind: BlockKind
  field: string
  def: FieldDef
}

export interface TableColumnMenuProps {
  column: TableColumn
  host: UiHost
  rect: DOMRect
  onClose(): void
}

export interface TableHeaderProps {
  kind: BlockKind
  host: UiHost
}

/**
 * 一种数据块在表格里提供的结构编辑能力。贡献到 table.tools v1；按贡献 order 从小到大，首个匹配的生效。
 * 注册表只收启用插件的贡献；休眠定义不提供编辑能力，仍由表格按定义显示已有值。
 * 表格提供列宽、列标题按钮和锚点位置；贡献者拥有菜单、表头附加区、业务规则及命令。
 */
export interface TableTools {
  match(kind: BlockKind): boolean
  columnMenu?: {
    title(column: TableColumn): string
    Component: FC<TableColumnMenuProps>
  }
  /** 表头末尾的附加区域：表格保留宽度，组件负责内容。 */
  header?: { width: number; Component: FC<TableHeaderProps>; emptyHint?: string }
  /** 单元格编辑器中新建选项；不提供时只能选已有值。 */
  addOption?(column: TableColumn, option: string, host: UiHost): Promise<void>
}
