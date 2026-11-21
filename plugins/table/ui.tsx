import { kindTitle, fieldTitle, enumTitle, pluginMessages as packageMessages, useLocale as useUiLocale } from '@resource-manager/plugin-api/ui/locale'
import './table.css'
// 表格布局：一行一个素材，一列一个字段，格子里直接编辑（设计文档 11.4）。
// 按公共数据块定义选列；表头的结构编辑由匹配的插件贡献。
// 其他视图显示几列常用字段。显示和编辑都用宿主的值类型呈现与编辑器。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BlockKind, EntityView, FieldDef } from '@resource-manager/plugin-api/blocks'
import { editable, editsInPlace, editsInPopover, FieldEditor, writeField } from '@resource-manager/plugin-api/ui/fields'
import { useUiEffect, useUiFrame } from '@resource-manager/plugin-api/ui/hooks'
import { useEntity, useKinds } from '@resource-manager/plugin-api/ui/data'
import type { LayoutProps, UiHost, UiPlugin } from '@resource-manager/plugin-api/ui/contracts'
import { ResourceCover } from '@resource-manager/plugin-api/ui/media'
import { FieldValue, Overlay } from '@resource-manager/plugin-api/ui/widgets'
import type { TableColumn as Column } from './contract'
import { ExtensionBoundary, type UiExtension } from '@resource-manager/plugin-api/ui/extensions'
import { tableToolsPoint, toolsFor, columnTitle } from './tools-contract'
import { columnKey, focusTemplate, resolveColumns, type ResolvedColumn } from './columns'
import { ColumnOptions } from './column-options'

const uiText = packageMessages('table')


const DEFAULT_ROW_HEIGHT = 40
const OVERSCAN = 10
const FIRST_COL = 280

function widthOf(def: FieldDef): number {
  if (def.type === 'boolean') return 72
  if (def.format === 'rating') return 120
  if (def.type === 'number' || def.type === 'date') return 120
  if (def.type === 'enum') return def.list ? 200 : 130
  if (def.type === 'longtext' || def.list || def.format === 'url') return 220
  return 170
}

function TableLayout({ query, options, ids, selection, host, visible, anchor, onAnchor, state, onState, onPointer, onOpen, onBackground, onBackgroundMenu, dragIds }: LayoutProps) {
  useUiLocale()
  const kinds = useKinds()
  const focus = focusTemplate(query, kinds)
  const columns = useMemo(() => resolveColumns(options, query, kinds), [options, query, kinds])
  const headerTools = focus && toolsFor(host, focus)
  const header = headerTools?.value.header
  const Header = header?.Component
  const width = FIRST_COL + columns.reduce((s, c) => s + (c.column ? widthOf(c.column.def) : 170), 0) + (header?.width ?? 0)

  // ---------- 虚拟化：只渲染看得见的行 ----------

  const scroller = useRef<HTMLDivElement>(null)
  const metric = useRef<HTMLSpanElement>(null)
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT)
  const appliedHeight = useRef(rowHeight)
  const pendingOffset = useRef<number | undefined>(undefined)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  useUiEffect(display => {
    const el = scroller.current!, probe = metric.current!
    const measure = () => {
      if (!el.clientHeight || !probe.offsetHeight) return
      if (probe.offsetHeight !== appliedHeight.current) {
        // 在更新虚拟滚动区域之前记下首行及行内偏移；收缩时浏览器可能钳制 scrollTop。
        pendingOffset.current = el.scrollTop / appliedHeight.current
      }
      setRowHeight(probe.offsetHeight)
      setViewport({ top: el.scrollTop, height: el.clientHeight })
    }
    measure()
    display.observeResize([el, probe], measure)
  }, [])
  const restored = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el?.clientHeight || !ids.length || metric.current?.offsetHeight !== rowHeight) return
    if (!restored.current) {
      el.scrollTop = Math.max(0, anchor ? ids.indexOf(anchor) : 0) * rowHeight
      if (typeof state?.left === 'number' && Number.isFinite(state.left)) el.scrollLeft = Math.max(0, state.left)
      restored.current = true
    } else if (rowHeight !== appliedHeight.current && pendingOffset.current !== undefined) {
      el.scrollTop = pendingOffset.current * rowHeight
    } else {
      return
    }
    appliedHeight.current = rowHeight
    pendingOffset.current = undefined
    setViewport({ top: el.scrollTop, height: el.clientHeight })
  }, [ids, anchor, state, rowHeight, viewport.height, visible])
  const first = Math.max(0, Math.floor(viewport.top / rowHeight) - OVERSCAN)
  const last = Math.min(ids.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + OVERSCAN)
  const shown = useMemo(() => ids.slice(first, last), [ids, first, last])

  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => host.core.visible(shown), 200)
    return () => clearTimeout(t)
  }, [shown, host, visible])

  const scheduleFrame = useUiFrame()
  const frame = useRef<() => void>(undefined)
  const onScroll = () => {
    frame.current?.()
    frame.current = scheduleFrame(() => {
      const el = scroller.current
      if (el) {
        setViewport({ top: el.scrollTop, height: el.clientHeight })
        const top = ids[Math.min(ids.length - 1, Math.floor(el.scrollTop / appliedHeight.current))]
        if (top) onAnchor(top)
        onState({ left: el.scrollLeft })
      }
    })
  }

  // ---------- 编辑：同一时间只有一个格子在编辑 ----------

  const [editing, setEditing] = useState<{ id: string; col: string; rect: DOMRect }>()
  const stopEditing = useCallback(() => setEditing(undefined), [])
  const startEditing = useCallback((id: string, col: string, rect: DOMRect) => setEditing({ id, col, rect }), [])

  const optionAdder = (c: Column) => {
    const entry = toolsFor(host, c.kind)
    return entry?.value.addOption ? (option: string) => host.extensions.invoke(entry, tools => tools.addOption!(c, option, host)) : undefined
  }

  return (
    <div
      className="table-scroller"
      role="region" aria-label={uiText("素材表格")}
      onContextMenu={(e) => {
        if (!(e.target as Element).closest('.table-head')) onBackgroundMenu(e)
      }}
      ref={scroller}
      onScroll={onScroll}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('table-body')) onBackground()
      }}
    >
      <span ref={metric} aria-hidden="true" className="table-row-metric" />
      <div className="table-head" style={{ width }}>
        <div className="th first" style={{ width: FIRST_COL }}>{uiText("素材")}{' '}</div>
        {columns.map(({ref,column}) => column
          ? <HeaderCell key={columnKey(ref)} column={column} host={host} qualified={options.columnMode === 'custom'} />
          : <div className="th" key={columnKey(ref)} style={{width:170}} title={`${ref.kind} · ${ref.field}`}>{uiText("字段暂不可用")}</div>)}
        {focus && headerTools && header && Header && (
          <div className="th add" style={{ width: header.width }}>
            <ExtensionBoundary key={focus.id} extensions={host.extensions} extension={headerTools} fallback={<ToolError entry={headerTools} host={host}/>}><Header host={host} kind={focus} /></ExtensionBoundary>
          </div>
        )}
      </div>
      <div className="table-body" style={{ height: ids.length * rowHeight, width }}>
        {shown.map((id, i) => (
          <Row
            key={id}
            id={id}
            top={(first + i) * rowHeight}
            height={rowHeight}
            columns={columns}
            host={host}
            selected={selection.has(id)}
            editingCol={editing?.id === id ? editing.col : undefined}
            onEdit={startEditing}
            onPointer={onPointer}
            onOpen={onOpen}
            dragIds={dragIds}
          />
        ))}
      </div>
      {ids.length === 0 && (
        <div className="empty">
          <p>{focus?.dormant ? uiText("「{title}」所属插件已停用，已有数据仍可查看", { title: String(focus.title) }) : focus ? uiText("把素材拖到这里，就会挂上「{title}」", { title: String(focus.title) }) : uiText("没有素材")}</p>
          {!columns.length && header?.emptyHint && <p className="muted">{header.emptyHint}</p>}
        </div>
      )}
      {editing && (
        <CellPopover
          key={`${editing.id}.${editing.col}`}
          id={editing.id}
          column={columns.find(c => columnKey(c.ref) === editing.col)?.column}
          rect={editing.rect}
          host={host}
          addOption={optionAdder}
          onDone={stopEditing}
        />
      )}
    </div>
  )
}


interface RowProps {
  id: string
  top: number
  height: number
  columns: ResolvedColumn[]
  host: UiHost
  selected: boolean
  editingCol?: string
  onEdit(id: string, col: string, rect: DOMRect): void
  onPointer: LayoutProps['onPointer']
  onOpen: LayoutProps['onOpen']
  dragIds: LayoutProps['dragIds']
}

const Row = memo(function Row({ id, top, height, columns, host, selected, editingCol, onEdit, onPointer, onOpen, dragIds }: RowProps) {
  const view = useEntity(id)
  return (
    <div
      className={`table-row${selected ? ' selected' : ''}`}
      data-entity-id={id}
      data-selected={selected || undefined}
      style={{ top, height }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea, button, select')) return
        onPointer(id, e)
      }}
    >
      <div
        className="td first"
        style={{ width: FIRST_COL }}
        draggable={!!view}
        onDragStart={(e) => host.startDrag(e, dragIds(id))}
        onDoubleClick={() => onOpen(id)}
      >
        <span className="table-thumb">{view ? <ResourceCover view={view} host={host} /> : null}</span>
        <span className="table-title">{view ? host.title(view) : ''}</span>
      </div>
      {columns.map(({ref,column}) => column
        ? <Cell key={columnKey(ref)} column={column} view={view} host={host} editing={editingCol === columnKey(ref)} onEdit={rect => onEdit(id, columnKey(ref), rect)} />
        : <div className="td muted" key={columnKey(ref)} style={{width:170}}>—</div>)}
    </div>
  )
})

function Cell({ column: c, view, host, editing, onEdit }: { column: Column; view?: EntityView; host: UiHost; editing: boolean; onEdit(rect: DOMRect): void }) {
  useUiLocale()
  const value = view?.blocks[c.kind.id]?.data[c.field]
  const canEdit = !!view && editable(c.kind)
  const style = { width: widthOf(c.def) }
  if (view && c.kind.template && !view.blocks[c.kind.id]) return <div className="td" style={style}>
    {canEdit ? <AttachTemplate host={host} id={view.id} kind={c.kind}/> : <span className="muted">{uiText("未添加模板")}</span>}
  </div>
  // 勾选、星星：直接在格子里操作
  if (canEdit && editsInPlace(c.def)) {
    return (
      <div className="td" style={style}>
        <FieldEditor def={c.def} value={value} onChange={(v) => void writeField(host, view!, c.kind.id, c.field, v)} />
      </div>
    )
  }
  return (
    <div
      className={`td${canEdit ? ' editable' : ''}${editing ? ' editing' : ''}`}
      style={style}
      onClick={(e) => canEdit && onEdit(e.currentTarget.getBoundingClientRect())}
    >
      {value !== undefined && <FieldValue def={c.def} value={value} optionLabel={v => enumTitle(c.kind, c.field, v)} />}
    </div>
  )
}

function AttachTemplate({host,id,kind}:{host:UiHost;id:string;kind:BlockKind}) {
  useUiLocale()
  const [busy,setBusy] = useState(false), [error,setError] = useState('')
  return <><button className="link" disabled={busy} title={uiText("添加「{title}」后填写", { title: String(kindTitle(kind)) })} onClick={async () => {
    setBusy(true);setError('')
    try { await host.core.patch(id,kind.id,{}) } catch(e) { setError(String(e)) } finally { setBusy(false) }
  }}>{uiText("添加模板")}</button>{error&&<span role="alert" title={error}>{uiText("添加失败")}</span>}</>
}

/**
 * 正在编辑的格子：盖在格子上（单行输入）或从格子下方弹出（选项、长文本、列表）。
 * 挂到 body 上：表格的滚动区域会把它裁掉。
 */
function CellPopover({
  id,
  column,
  rect,
  host,
  addOption,
  onDone
}: {
  id: string
  column?: Column
  rect: DOMRect
  host: UiHost
  addOption(c: Column): ((o: string) => Promise<void>) | undefined
  onDone(): void
}) {
  const view = useEntity(id)
  if (!column || !view || !editable(column.kind) || (column.kind.template && !view.blocks[column.kind.id])) return null
  const popover = editsInPopover(column.def)
  const editor = (
    <FieldEditor
      def={column.def}
      optionLabel={v => enumTitle(column.kind, column.field, v)}
      value={view.blocks[column.kind.id]?.data[column.field]}
      autoFocus
      onChange={(v) => void writeField(host, view, column.kind.id, column.field, v)}
      onAddOption={addOption(column)}
      onDone={onDone}
    />
  )
  return (
    <Overlay onClose={onDone}>
      <div
        className={popover ? 'cell-popover' : 'cell-inline'}
        style={
          popover
            ? { left: rect.left, top: rect.bottom + 4, minWidth: Math.max(rect.width, 220) }
            : { left: rect.left, top: rect.top, width: Math.max(rect.width, 160), height: rect.height }
        }
      >
        {editor}
      </div>
    </Overlay>
  )
}

/** 窄表头不能容纳整段错误说明；来源与详情放到提示和诊断入口。 */
function ToolError({ entry, host }: { entry: UiExtension; host: UiHost }) {
  useUiLocale()
  return <span role="alert"><button className="th-label" aria-label={uiText("查看 {pluginId} 工具错误", { pluginId: String(entry.pluginId) })}
    title={uiText("附加工具出错（{pluginId}），查看插件协作问题", { pluginId: String(entry.pluginId) })}
    onClick={() => void host.openSettings({ scope: 'library', section: 'plugins' })}>!</button></span>
}

function HeaderCell({ column: c, host, qualified }: { column: Column; host: UiHost; qualified: boolean }) {
  const [menu, setMenu] = useState<DOMRect>()
  const tools = toolsFor(host, c.kind)
  const Menu = tools?.value.columnMenu?.Component
  return (
    <div className="th" style={{ width: widthOf(c.def) }} title={columnTitle(host, tools, c, kindTitle(c.kind))}>
      <button className="th-label" disabled={!Menu} onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>
        {qualified ? `${kindTitle(c.kind)} · ${fieldTitle(c.kind, c.field)}` : fieldTitle(c.kind, c.field)}
      </button>
      {menu && Menu && tools && <ExtensionBoundary extensions={host.extensions} extension={tools} fallback={<ToolError entry={tools} host={host}/>}><Menu column={c} host={host} rect={menu} onClose={() => setMenu(undefined)} /></ExtensionBoundary>}
    </div>
  )
}

export const tableUi: UiPlugin = {
  id: 'table',
  extensionPoints: [tableToolsPoint],
  layouts: [{ id: 'table', get title() { return uiText("表格") }, get description() { return uiText("一行一个素材，查看并编辑结构化字段。") }, size: false, Component: TableLayout, Options: ColumnOptions }]
}

export { tableUi as plugin }
