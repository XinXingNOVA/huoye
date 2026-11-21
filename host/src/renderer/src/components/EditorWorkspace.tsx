import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { useToolDrag } from './ToolDrag'
import { SIDEBAR_DRAG } from './SidebarDropLayer'
import { describeTab, describeTools } from '../workbench-content'
import { toolIdOf } from '../workspace'
import type { SidebarCatalog } from '../sidebar-catalog'
import type { WorkspaceDocking } from '../app/workspace-docking'
import { editorMenus } from './editor-menus'
import { editorGroupFromTarget, measureEditorGroups } from './workbench-geometry'
import { hitEditorDrop } from '../workbench-hit-test'
import { pageInputReason } from '../../../shared/page-inputs'
import { pageInputsFor, tabTypeOf } from '../ui-registry'
import { viewTitle, t } from '../language'
import { ViewDropHint } from './ViewDropHint'
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import type { UiHost } from '../plugin'
import type { Workspace, TabEntry } from '../workspace'
import { canSplitEditor, editorGeometry, editorMinimum, editorsOf, groupOf, nodeGroups, type EditorEdge, type EditorRect } from '../editor-layout'
import { useEditorDrag, TAB_DRAG } from './EditorDrag'
import { SurfaceSlot, surfaceSlot } from '../surface-slots'
import { TabBar } from './TabBar'
interface Props {
  workspace: Workspace; host: UiHost; catalog: SidebarCatalog; docking: WorkspaceDocking
  drop?: { tab: string; header: boolean; zone?: string; internal: boolean }
  startControls?: ReactNode
  endControls?: ReactNode
  onSelect(id: string): void
  onClose(id: string): void
  onDuplicate(id: string, group: string, destination?: string): void
  onNew(group: string): void
  onMove(id: string, group: string, before?: string): void
  onSplit(group: string, edge: EditorEdge, tab?: string): void
  onJoin(source?: string, target?: string): void
  onBalance(): void
  onResize(id: string, ratio: number): void
  groupId?: string
  onDetach(id: string, point?: { x: number; y: number }): void
  onReturn(group: string): void
}
type Drop = { group: string; edge?: EditorEdge; before?: string; blocked?: string }
const position = (r: EditorRect): CSSProperties => ({ left: r.x, top: r.y, width: r.width, height: r.height })
export function EditorWorkspace(p: Props) {
  useUiLocale()
  const toolDrag = useToolDrag(), tools = describeTools(p.workspace, p.catalog)
  const fullLayout = editorsOf(p.workspace), layout = p.groupId ? { ...fullLayout, root: { type: 'group' as const, id: p.groupId } } : fullLayout, order = nodeGroups(layout.root), focused = groupOf(p.workspace)?.id
  const root = useRef<HTMLDivElement>(null), probe = useRef<HTMLDivElement>(null), drag = useEditorDrag()
  const [size, setSize] = useState({ width: 0, height: 0, finalWidth: 0 }), [over, setOver] = useState<Drop>(), [resizing, setResizing] = useState(false)
  useUiEffect(display => {
    const el = root.current!, measurement = probe.current!, update = () => { const finalWidth = measurement.getBoundingClientRect().width; setSize(old => old.width === el.clientWidth && old.height === el.clientHeight && old.finalWidth === finalWidth ? old : { width: el.clientWidth, height: el.clientHeight, finalWidth }) }
    display.observeResize([el, measurement], update); update()
  }, [])
  useEffect(() => { if (!toolDrag.value && !drag.id) setOver(undefined) }, [toolDrag.value, drag.id])
  const geometry = editorGeometry(layout.root, size.width, size.height)
  // 保留侧栏动画期间瀑布流按最终宽度排版的约定，避免每帧重新分列。
  const finalGeometry = editorGeometry(layout.root, size.finalWidth, size.height)
  const topRight = [...geometry.groups].filter(([, r]) => r.y === 0).sort((a, b) => (b[1].x + b[1].width) - (a[1].x + a[1].width))[0]?.[0]
  const finish = (event?: DragEvent) => { drag.end(event); toolDrag.end(); setOver(undefined) }
  const hit = (e: DragEvent): Drop | undefined => {
    const target = hitEditorDrop(measureEditorGroups(root.current!), { x: e.clientX, y: e.clientY }, editorGroupFromTarget(root.current!, e.target))
    if (!target || !geometry.groups.has(target.group)) return
    const { group, before } = target, split = p.groupId ? undefined : target.edge
    const blocked = !toolDrag.value && split && !canSplitEditor(geometry.groups.get(group)!, split)
      ? uiText("区域空间不足，可先调整区域大小") : undefined
    return { group, edge: split, before, blocked: (toolDrag.value && p.docking.preview(toolDrag.value, { region: 'center', group, edge: split, before })) || blocked }
  }
  const accept = (e: DragEvent) => !!drag.id && e.dataTransfer.types.includes(TAB_DRAG) || !!toolDrag.value && e.dataTransfer.types.includes(SIDEBAR_DRAG)
  const { menu, tabMenu } = editorMenus({ ...p, floating: !!p.groupId }, geometry)
  return <div ref={root} className={`editor-workspace${resizing ? ' editor-resizing' : ''}`} data-dragging={!!drag.id || !!toolDrag.value}
    onDragOverCapture={e => { if (!accept(e)) return; e.preventDefault(); e.stopPropagation(); const next = hit(e); e.dataTransfer.dropEffect = next?.blocked ? 'none' : toolDrag.value?.type === 'context-tool' ? 'copy' : 'move'; setOver(old => JSON.stringify(old) === JSON.stringify(next) ? old : next) }}
    onDropCapture={e => { if (!accept(e)) return; e.preventDefault(); e.stopPropagation(); const next = hit(e), id = drag.id!; if (next && !next.blocked) { if (!id && toolDrag.value) p.docking.place(toolDrag.value, { region: 'center', group: next.group, edge: next.edge, before: next.before }); else if (next.edge) p.onSplit(next.group, next.edge, id); else p.onMove(id, next.group, next.before) } finish() }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(undefined) }}>
    <div ref={probe} className="editor-size-probe" style={{ minWidth: editorMinimum(layout.root).width }} aria-hidden="true"/>
    <div className="editor-canvas" style={{ width: geometry.width, height: geometry.height }}>
      {order.map((id, index) => {
        const group = layout.groups.find(g => g.id === id)!, r = geometry.groups.get(id)!
        return <section key={id} className="editor-group" data-editor-group={id} data-focused={focused === id} data-top-left={r.x === 0 && r.y === 0} data-window-top={r.y === 0} aria-label={uiText("内容区域 {value1}", { value1: String(index + 1) })}
          style={{ ...position(r), '--workspace-main-width': `${finalGeometry.groups.get(id)!.width}px` } as CSSProperties}
          onPointerDownCapture={e => { if (e.button !== 1 && !(e.target as Element).closest('.tab-x, .panel-toggle')) p.onSelect(group.active) }} onFocusCapture={e => { if (!(e.target as Element).closest('.tab-x, .panel-toggle')) p.onSelect(group.active) }}>
          <div className="window-toolbar" data-editor-header onKeyDown={e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation() }}>
            {r.x === 0 && r.y === 0 && p.startControls}
            <TabBar describe={entry => describeTab(entry, tools, tabTypeOf(entry.type))} tabs={group.tabs.flatMap(id => p.workspace.tabs.find(t => t.id === id) ?? [])} active={group.active} host={p.host}
              dropTarget={over?.before ?? (p.drop?.header ? p.drop.tab : undefined)} onSelect={p.onSelect} onClose={p.onClose} onNew={() => p.onNew(group.id)} onTabMenu={tabMenu} onDragEnd={finish} dropProps={() => ({})}
              onDragStart={(e, id) => { const tool = toolIdOf(p.workspace.tabs.find(t => t.id === id)); if (tool) toolDrag.start(e, { type: 'view', id: tool }); drag.start(e, id) }}/>
            {r.y === 0 && <span className="window-drag-space" aria-hidden="true"/>}
            <button className="editor-layout-button" title={uiText("区域操作")} aria-label={uiText("区域操作")} aria-haspopup="menu" onClick={() => void menu(id)}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
            </button>
            {id === topRight && p.endControls}
          </div>
          <SurfaceSlot className="tab-stack" slot={surfaceSlot('editor', id)}>
            {(drag.id || toolDrag.value) && <div className="editor-layout-drop-layer" aria-hidden="true"/>}
            {p.drop && group.tabs.includes(p.drop.tab) && <DropHint entry={p.workspace.tabs.find(t => t.id === p.drop!.tab)!} zone={p.drop.zone} internal={p.drop.internal} />}
          </SurfaceSlot>
          {over?.group === id && !over.before && <div className={`editor-drop-preview${over.blocked ? ' blocked' : ''}`} data-edge={over.edge ?? 'center'}>{over.blocked ? over.blocked : over.edge ? uiText("松开以分割并移入") : uiText("加入此区域")}</div>}
        </section>
      })}
      {geometry.splits.map(s => <EditorResize key={s.node.id} split={s} onResize={ratio => p.onResize(s.node.id, ratio)} onDragging={setResizing}/>)}
    </div>
  </div>
}
function EditorResize({ split: s, onResize, onDragging }: { split: ReturnType<typeof editorGeometry>['splits'][number]; onResize(ratio: number): void; onDragging(value: boolean): void }) {
  useUiLocale()
  const drag = useRef<{ point: number; size: number; ratio: number } | null>(null), columns = s.node.direction === 'columns'
  const finish = () => { drag.current = null; onDragging(false) }, resize = (n: number) => onResize(Math.max(s.min, Math.min(s.max, n)))
  return <div className="editor-resize" data-direction={s.node.direction} role="separator" tabIndex={0} aria-label={uiText("调整区域大小")} aria-orientation={columns ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(s.ratio * 100)} aria-valuemin={Math.round(s.min * 100)} aria-valuemax={Math.round(s.max * 100)} style={position(s.rect)}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { point: columns ? e.clientX : e.clientY, size: s.size, ratio: s.ratio }; onDragging(true) }}
    onPointerMove={e => { const d = drag.current; if (d) resize(d.ratio + ((columns ? e.clientX : e.clientY) - d.point) / d.size) }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={() => resize(0.5)}
    onKeyDown={e => { const minus = columns ? 'ArrowLeft' : 'ArrowUp', plus = columns ? 'ArrowRight' : 'ArrowDown'; if ([minus, plus, 'Home'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); resize(e.key === 'Home' ? 0.5 : s.ratio + (e.key === plus ? 0.05 : -0.05)) } }}/>
}

function DropHint({ entry, zone, internal }: { entry: TabEntry; zone?: string; internal: boolean }) {
  const type = tabTypeOf(entry.type), blocked = pageInputReason(pageInputsFor(entry), 'receive')
  if (blocked) return <div className="drop-overlay"><div className="drop-hint" role="status"><strong>{blocked}</strong></div></div>
  const query = type?.dropQuery?.(entry.params, entry.state, zone)
  return <div className="drop-overlay"><ViewDropHint query={query} title={viewTitle(entry.params.presetId as string | undefined, String(entry.params.title ?? t('drop.currentView')))} internal={internal} /></div>
}
