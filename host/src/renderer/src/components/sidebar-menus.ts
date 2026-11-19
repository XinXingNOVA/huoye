import type { ContainerTool, SidebarContainerSnapshot, SidebarSnapshot } from '../workbench-containers'
import type { ContainerActions } from '../app/container-actions'
import type { WorkspaceDocking } from '../app/workspace-docking'
import type { DockSource as SidebarDrag } from '../workbench-placement'
import type { UiHost } from '../plugin'
import type { SidebarSide } from '../sidebar-layout'

interface Options {
  snapshot: SidebarSnapshot
  actions: ContainerActions
  docking: WorkspaceDocking
  host: Pick<UiHost, 'contextMenu'>
  onLocate(id: string): void
}
/** 菜单只保存明确目标；执行交给宿主动作，以最新工作区复核。 */
export function sidebarMenus(p: Options) {
  const { tools: views, groups: allGroups } = p.snapshot
  const groupsFor = (side?: SidebarSide) => allGroups.filter(c => c.present && (!side || c.side === side))
  const moveToSide = (value: SidebarDrag, side: SidebarSide) => p.docking.place(value, { region: side })
  const into = (value: SidebarDrag, c: SidebarContainerSnapshot) => p.docking.place(value, { region: c.side, group: c.id })
  const close = (id: string) => p.actions.closeTool(id)
  const reveal = (id: string) => {
    const page = views.find(v => v.id === id)?.pageId
    if (page) p.onLocate(page)
    else p.actions.showTool(id)
  }
  const viewMenu = async (v: ContainerTool) => {
    const c = allGroups.find(c => c.members.includes(v.id))
    if (!c) { const id = await p.host.contextMenu([{ id: 'open', label: '定位主工作区中的工具' }, { id: 'left', label: '移到左侧栏' }, { id: 'right', label: '移到右侧栏' }]); if (id === 'open') reveal(v.id); else if (id === 'left' || id === 'right') moveToSide({ type: 'view', id: v.id }, id); return }
    const available = groupsFor(), index = c.members.indexOf(v.id)
    const id = await p.host.contextMenu([
      ...(v.source?.available ? [{ id: 'locate-source', label: `定位来源页面「${v.source.title}」` }] : []),
      ...(!p.docking.reason({ type: 'view', id: v.id }, 'center') ? [{ id: 'center', label: '移到主工作区' }, { id: 'window', label: '移到新窗口' }] : []),
      { id: 'left', label: '独立放到左侧栏' }, { id: 'right', label: '独立放到右侧栏' },
      ...available.filter(x => x.id !== c.id && x.type === 'tabs').map(x => ({ id: `join:${x.id}`, label: `加入「${x.title}」${x.side === 'left' ? '（左）' : '（右）'}` })),
      ...(index > 0 ? [{ id: 'previous', label: '工具前移' }] : []),
      ...(index < c.members.length - 1 ? [{ id: 'next', label: '工具后移' }] : []),
      ...(!v.binding ? [{ id: 'reset', label: '恢复此工具默认位置' }] : []), { id: 'close', label: '关闭此工具' }
    ])
    if (id === 'locate-source' && v.source?.available) p.onLocate(v.source.id)
    else if (id === 'window') void p.docking.detach({ type: 'view', id: v.id })
    else if (id === 'center') p.docking.place({ type: 'view', id: v.id }, { region: 'center' })
    else if (id === 'left' || id === 'right') moveToSide({ type: 'view', id: v.id }, id)
    else if (id?.startsWith('join:')) {
      const target = available.find(x => x.id === id.slice(5))
      if (target) into({ type: 'view', id: v.id }, target)
    } else if (id === 'previous') p.actions.reorderTool(v.id, c.id, -1)
    else if (id === 'next') p.actions.reorderTool(v.id, c.id, 1)
    else if (id === 'reset') p.actions.resetTool(v.id)
    else if (id === 'close') close(v.id)
  }
  const contextToolMenu = async (c: SidebarContainerSnapshot, id: string) => {
    const context = c.context, source = context?.source, tool = context?.candidates.find(t => t.id === id)
    if (!source || !tool) return
    const at = context.order.indexOf(id)
    const action = await p.host.contextMenu([
      ...(tool.detachable ? tool.regions.map(region => ({ id: `pin-${region}`, label: `固定到${{ left: '左侧栏', center: '主工作区', right: '右侧栏' }[region]}` })) : []),
      ...(tool.detachable && tool.regions.includes('center') ? [{ id: 'window', label: '在新窗口固定此工具' }] : []),
      ...(at > 0 ? [{ id: 'previous', label: '工具前移' }] : []),
      ...(at < context.order.length - 1 ? [{ id: 'next', label: '工具后移' }] : []),
      { id: 'hide', label: '在此类页面隐藏' }
    ])
    if (action === 'pin-left' || action === 'pin-right' || action === 'pin-center') p.docking.place({ type: 'context-tool', id, pageId: source.pageId, containerId: c.id }, { region: action.slice(4) as 'left' | 'center' | 'right' })
    else if (action === 'window') void p.docking.detach({ type: 'context-tool', id, pageId: source.pageId, containerId: c.id })
    else if (action === 'hide') p.actions.configureContext(c.id, source, { type: 'hide', tool: id })
    else if (action === 'previous' || action === 'next') p.actions.configureContext(c.id, source, { type: 'reorder', tool: id, direction: action === 'previous' ? -1 : 1 })
  }
  const groupMenu = async (c: SidebarContainerSnapshot) => {
    const side = c.side === 'left' ? 'right' : 'left', groups = groupsFor(c.side), index = groups.findIndex(g => g.id === c.id)
    const context = c.context, source = context?.source, current = c.items.find(t => t.id === c.active)
    const id = await p.host.contextMenu([
      ...(current ? [{ id: 'current', label: `「${current.label}」的操作…` }] : []),
      ...(source && context ? [
        ...(context.active ? [{ id: 'current-context', label: '当前工具的操作…' }] : []),
        ...context.candidates.map(t => ({ id: `context:${t.id}`, label: `${context.order.includes(t.id) ? '✓ ' : ''}${t.title}` })),
        { id: 'reset-context', label: '恢复此类页面的默认工具' }
      ] : []),
      { id: 'tools', label: '添加或打开工具…' },
      { type: 'separator' },
      { id: 'move', label: `将整组移到${side === 'left' ? '左' : '右'}侧栏` },
      ...(index > 0 ? [{ id: 'up', label: '整组上移' }] : []), ...(index < groups.length - 1 ? [{ id: 'down', label: '整组下移' }] : []),
      { type: 'separator' },
      ...(current ? [{ id: 'close-current', label: '关闭当前工具' }] : []),
      { id: 'close', label: '关闭此组工具' }
    ])
    if (id === 'current' && current) await viewMenu(current)
    else if (id === 'close-current' && current) close(current.id)
    else if (id === 'current-context' && context?.active) await contextToolMenu(c, context.active)
    else if (id === 'reset-context' && source) p.actions.configureContext(c.id, source, { type: 'reset' })
    else if (id?.startsWith('context:') && source && context?.candidates.some(t => t.id === id.slice(8))) p.actions.configureContext(c.id, source, { type: 'toggle', tool: id.slice(8) })
    else if (id === 'move') moveToSide({ type: 'container', id: c.id }, side)
    else if (id === 'up') p.actions.reorderGroup(c.id, -1)
    else if (id === 'down') p.actions.reorderGroup(c.id, 1)
    else if (id === 'close') p.actions.closeGroup(c.id)
    else if (id === 'tools') await toolsMenu(c.type === 'tabs' ? c : undefined)
  }
  const toolsMenu = async (target?: SidebarContainerSnapshot) => {
    const id = await p.host.contextMenu([
      ...views.map(v => ({ id: `view:${v.id}`, label: `${target ? '加入' : '打开'} ${v.title}` })),
      { id: 'add-context-left', label: '在左侧新增智能工具组' }, { id: 'add-context-right', label: '在右侧新增智能工具组' },
      { id: 'reset-layout', label: '恢复默认侧栏布局' }
    ])
    if (id === 'add-context-left' || id === 'add-context-right') p.actions.addContext(id === 'add-context-left' ? 'left' : 'right')
    else if (id === 'reset-layout') p.actions.resetSidebars()
    else if (id?.startsWith('view:')) {
      const view = id.slice(5)
      if (target) into({ type: 'view', id: view }, target)
      else reveal(view)
    }
  }
  return { reveal, viewMenu, contextToolMenu, groupMenu, toolsMenu }
}
