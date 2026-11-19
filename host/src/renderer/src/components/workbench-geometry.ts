import { displayWindows, asElement } from '../display-windows'
import { groupOf, type EditorRect } from '../editor-layout'
import type { DockTarget, PlacementSpace } from '../workbench-placement'
import type { GroupGeometry } from '../workbench-hit-test'
import type { SidebarSide } from '../sidebar-layout'
import type { Workspace } from '../workspace'

/** 宿主外壳的测量适配；语义标记不依赖 CSS 名称或中间包装层，不对插件开放。 */
export function measureRect(el: Element): EditorRect {
  const { x, y, width, height } = el.getBoundingClientRect()
  return { x, y, width, height }
}
export function measureEditorGroup(id: string): EditorRect | undefined {
  const el = displayWindows().map(w => w.document.querySelector(`[data-editor-group="${CSS.escape(id)}"]`)).find(Boolean)
  return el ? measureRect(el) : undefined
}
export function measureSidebarHeight(side: SidebarSide): number {
  return document.querySelector<HTMLElement>(`[data-workbench-region="${side}"]`)?.clientHeight ?? 0
}
export function measurePlacement(w: Workspace, target: DockTarget): PlacementSpace {
  return target.region === 'center'
    ? { editorRect: measureEditorGroup(target.group ?? groupOf(w)!.id) }
    : { sideHeight: measureSidebarHeight(target.region) }
}
function measureGroups(root: Element, groupAttribute: string, headerAttribute: string, itemAttribute: string): GroupGeometry[] {
  return [...root.querySelectorAll<HTMLElement>(`[${groupAttribute}]`)].flatMap(el => {
    const header = el.querySelector(`[${headerAttribute}]`), id = el.getAttribute(groupAttribute)
    if (!header || !id) return []
    return [{ id, rect: measureRect(el), header: measureRect(header), context: el.dataset.containerType === 'context',
      items: [...header.querySelectorAll<HTMLElement>(`[${itemAttribute}]`)].map(item => ({ id: item.getAttribute(itemAttribute)!, rect: measureRect(item) })) }]
  })
}
export const measureSidebarGroups = (root: Element) => measureGroups(root, 'data-container-id', 'data-container-header', 'data-tool-id')
export const measureEditorGroups = (root: Element) => measureGroups(root, 'data-editor-group', 'data-editor-header', 'data-tab')
export function measureSidebarPair(handle: Element, second: string): number {
  const region = handle.closest('[data-workbench-region]'), first = handle.closest<HTMLElement>('[data-container-id]')
  const next = region?.querySelector<HTMLElement>(`[data-container-id="${CSS.escape(second)}"]`)
  return Math.max(1, (first?.clientHeight ?? 0) + (next?.clientHeight ?? 0))
}

/** 事件直接落在组内时沿用其身份；遮罩承接事件时再按坐标命中。 */
export function editorGroupFromTarget(root: Element, target: EventTarget | null): string | undefined {
  const group = asElement(target)?.closest<HTMLElement>('[data-editor-group]')
  return group && root.contains(group) ? group.dataset.editorGroup : undefined
}
