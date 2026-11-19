/** 本机导航偏好；身份暂时不可见时保留位置，删除后撤销可回到原处。 */
export const SAVED_VIEW_DRAG = 'application/x-rm-saved-view'
export interface ViewNavigation { version: 1; order: string[]; pinned: string[] }
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))] : []
export function readViewNavigation(value: unknown): ViewNavigation {
  const data = value && typeof value === 'object' ? value as Partial<ViewNavigation> : {}
  return { version: 1, order: ids(data.order), pinned: ids(data.pinned) }
}
export function orderedViews(available: string[], navigation: ViewNavigation): string[] {
  const live = new Set(available)
  return [...new Set([...navigation.order, ...available])].filter(id => live.has(id))
}
export function pinView(navigation: ViewNavigation, id: string, pinned: boolean): ViewNavigation {
  return { ...navigation, pinned: pinned ? [...new Set([...navigation.pinned, id])] : navigation.pinned.filter(x => x !== id) }
}
export function moveSavedView(navigation: ViewNavigation, available: string[], id: string, target: string | undefined, pinned: boolean, after = false): ViewNavigation {
  if (!available.includes(id) || id === target || (target && !available.includes(target))) return navigation
  const order = [...new Set([...navigation.order, ...available])].filter(x => x !== id)
  const index = target ? order.indexOf(target) + Number(after) : order.length
  order.splice(index, 0, id)
  return { ...pinView(navigation, id, pinned), order }
}
