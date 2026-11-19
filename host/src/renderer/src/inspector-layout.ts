/** 本机呈现偏好。分区 ID 稳定，不使用素材 ID、模板名或当前可见序号。 */
export interface InspectorLayout { version: 1; order: string[]; collapsed: string[]; showInactive?: boolean }
export const emptyInspectorLayout = (): InspectorLayout => ({ version: 1, order: [], collapsed: [] })
export const inspectorLayoutKey = (root: string) => `inspector:layout:${root}`
export function readInspectorLayout(raw: string | null): InspectorLayout {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value?.version !== 1) return emptyInspectorLayout()
    const ids = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 500))].slice(0, 4096) : []
    return { version: 1, order: ids(value.order), collapsed: ids(value.collapsed), ...(value.showInactive === true ? { showInactive: true } : {}) }
  } catch { return emptyInspectorLayout() }
}
/** 隐藏或暂时缺失的分区保留位置；新分区靠近默认相邻项，绝不重排已有顺序。 */
export function mergeInspectorOrder(saved: string[], defaults: string[]): string[] {
  const order = [...new Set(saved)]
  const unique = [...new Set(defaults)]
  for (let i = 0; i < unique.length; i++) {
    const id = unique[i]
    if (order.includes(id)) continue
    const previous = unique.slice(0, i).reverse().find(s => order.includes(s))
    const following = unique.slice(i + 1).find(s => order.includes(s))
    const index = previous ? order.indexOf(previous) + 1 : following ? order.indexOf(following) : order.length
    order.splice(index, 0, id)
  }
  return order
}
export function moveInspectorSection(layout: InspectorLayout, defaults: string[], id: string, target: string, after = false): InspectorLayout {
  if (id === target || !defaults.includes(id) || !defaults.includes(target)) return layout
  const order = mergeInspectorOrder(layout.order, defaults).filter(s => s !== id)
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id)
  return { ...layout, order }
}
