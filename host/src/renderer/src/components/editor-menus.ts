import { uiText } from '../../../shared/i18n/interface-display'
import { editorsOf, groupOf, nodeGroups, otherGroup, canSplitEditor, type EditorEdge, type EditorRect } from '../editor-layout'
import { toolIdOf, type Workspace } from '../workspace'
import { allowsNewView } from '../page-instances'
import { tabTypeOf } from '../ui-registry'
import type { WorkspaceDocking } from '../app/workspace-docking'
import type { ContextMenuItem, UiHost } from '../plugin'

interface Options {
  workspace: Workspace
  host: Pick<UiHost, 'contextMenu'>
  docking: WorkspaceDocking
  floating?: boolean
  onDetach(id: string): void
  onReturn(group: string): void
  onClose(id: string): void
  onDuplicate(id: string, group: string, destination?: string): void
  onMove(id: string, group: string, before?: string): void
  onSplit(group: string, edge: EditorEdge, tab?: string): void
  onJoin(source?: string, target?: string): void
  onBalance(): void
}
export function editorMenus(p: Options, geometry: { groups: Map<string, EditorRect> }) {
  const layout = editorsOf(p.workspace), order = nodeGroups(layout.root)
  // 第一层只呈现任务；多个目标在第二步选择，不平铺所有区域。
  const destination = async (source: string, includeWindows = true): Promise<string | undefined> => {
    const targets = (includeWindows ? layout.groups.map(g => g.id) : order).filter(id => id !== source)
    if (targets.length <= 1) return targets[0]
    const selected = await p.host.contextMenu(targets.map(id => {
      const active = p.workspace.tabs.find(t => t.id === layout.groups.find(g => g.id === id)?.active)
      const title = active?.params.title ?? active?.params.name
      return { id, label: `${layout.groups.find(g => g.id === id)?.window ? uiText("独立窗口") : uiText("区域 {value1}", { value1: String(order.indexOf(id) + 1) })}${typeof title === 'string' && title ? ` · ${title}` : ''}` }
    }))
    return selected && targets.includes(selected) ? selected : undefined
  }
  const menu = async (group: string) => {
    const r = geometry.groups.get(group)
    if (!r) return
    const choices = (p.floating ? [] : ['right', 'bottom'] as const).filter(edge => canSplitEditor(r, edge)).map(edge => ({ id: edge, label: edge === 'right' ? uiText("向右分屏") : uiText("向下分屏") }))
    const items: ContextMenuItem[] = p.floating ? [{ id: 'return', label: uiText("全部移回主窗口") }] : [...choices]
    if (!p.floating && order.length > 1) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ id: 'balance', label: uiText("均分大小") })
      if (order.length > 2) items.push({ id: 'join', label: uiText("合并当前区域…") })
      items.push({ id: 'single', label: order.length === 2 ? uiText("合并为一个区域") : uiText("合并全部区域") })
    }
    const id = await p.host.contextMenu(items)
    if (id === 'return') p.onReturn(group)
    else if (id === 'single') p.onJoin()
    else if (id === 'balance') p.onBalance()
    else if (id === 'join') { const target = await destination(group, false); if (target) p.onJoin(group, target) }
    else if (choices.some(c => c.id === id)) p.onSplit(group, id as EditorEdge)
  }
  const tabMenu = async (id: string) => {
    const current = groupOf(p.workspace, id)!, other = otherGroup(layout, current.id)
    const entry = p.workspace.tabs.find(t => t.id === id)!
    const toolId = toolIdOf(entry), duplicate = !toolId && allowsNewView(tabTypeOf(entry.type))
    const action = await p.host.contextMenu([
      ...(toolId ? (['left', 'right'] as const).filter(side => !p.docking.reason({ type: 'view', id: toolId }, side)).map(side => ({ id: `side:${side}`, label: uiText("移到{value1}侧栏", { value1: String(side === 'left' ? uiText("左") : uiText("右")) }) })) : []),
      ...(duplicate ? [{ id: 'duplicate', label: uiText("在另一组新建此内容的视图") }] : []),
      ...(other ? [{ id: 'move', label: layout.groups.length === 2 ? uiText("移动到另一个区域") : uiText("移动到其他区域…") }] : []),
      ...(!toolId || !p.docking.reason({ type: 'view', id: toolId }, 'center') ? [{ id: 'detach', label: uiText("移到新窗口") }] : []),
      { type: 'separator' },
      { id: 'close', label: uiText("关闭标签页") }])
    if (toolId && (action === 'side:left' || action === 'side:right')) p.docking.place({ type: 'view', id: toolId }, { region: action === 'side:left' ? 'left' : 'right' })
    else if (action === 'duplicate' && duplicate) p.onDuplicate(id, current.id, other?.id)
    else if (action === 'move' && other) { const target = await destination(current.id); if (target) p.onMove(id, target) }
    else if (action === 'detach') p.onDetach(id)
    else if (action === 'close') p.onClose(id)
  }
  return { menu, tabMenu }
}
