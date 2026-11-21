import type { UiExtension, UiExtensionPoint } from '@resource-manager/plugin-api/ui/extensions'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'
import type { BlockKind } from '@resource-manager/plugin-api/blocks'
import type { TableTools, TableColumn } from './contract'

const component = (v: unknown) => typeof v === 'function' || (!!v && typeof v === 'object' && '$$typeof' in v && typeof v.$$typeof === 'symbol')
export const tableToolsPoint: UiExtensionPoint = {
  id: 'table.tools', version: 1,
  validate(value) {
    const v = value as Partial<TableTools> | null
    if (!v || typeof v !== 'object' || typeof v.match !== 'function') return '需要 match(kind)'
    if (v.columnMenu !== undefined && (!v.columnMenu || typeof v.columnMenu.title !== 'function' || !component(v.columnMenu.Component))) return 'columnMenu 需要 title 和 Component'
    if (v.header !== undefined && (!v.header || !Number.isFinite(v.header.width) || v.header.width <= 0 || !component(v.header.Component) || (v.header.emptyHint !== undefined && typeof v.header.emptyHint !== 'string'))) return 'header 需要正数 width、Component 和可选的 emptyHint'
    if (v.addOption !== undefined && typeof v.addOption !== 'function') return 'addOption 必须是函数'
  }
}

export function toolsFor(host: UiHost, kind: BlockKind): UiExtension<TableTools> | undefined {
  if (kind.dormant) return undefined
  for (const entry of host.extensions.list<TableTools>(tableToolsPoint.id, tableToolsPoint.version)) {
    try { if (entry.value.match(kind)) return entry }
    catch (error) { host.extensions.reportFailure(entry, error, 'render') }
  }
}
export function columnTitle(host: UiHost, entry: UiExtension<TableTools> | undefined, column: TableColumn, fallback = column.kind.title): string {
  try { return entry?.value.columnMenu?.title(column) ?? fallback }
  catch (error) { host.extensions.reportFailure(entry!, error, 'render'); return fallback }
}
