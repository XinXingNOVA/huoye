import type { EditorEdge, EditorRect } from './editor-layout'

export interface GroupGeometry {
  id: string
  rect: EditorRect
  header: EditorRect
  items: { id: string; rect: EditorRect }[]
  context?: boolean
}
export interface SidebarDropTarget { group?: string; edge?: 'top' | 'bottom'; beforeView?: string }
interface Point { x: number; y: number }
const bottom = (r: EditorRect) => r.y + r.height
const nextItem = (g: GroupGeometry, x: number) => g.items.find(t => x < t.rect.x + t.rect.width / 2)?.id

/** 屏幕几何 → 落点。只负责命中，来源能力、容量及提交复核仍归放置规则。 */
export function hitSidebarDrop(bounds: EditorRect, groups: GroupGeometry[], point: Point, groupOnly = false): { target: SidebarDropTarget; rect: EditorRect } {
  const group = groups.find(g => point.y < bottom(g.rect)) ?? groups.at(-1)
  let target: SidebarDropTarget = {}, rect = { x: 4, y: 4, width: bounds.width - 8, height: bounds.height - 8 }
  if (group) {
    const { rect: r, header } = group
    target = { group: group.id }
    const y = (point.y - bottom(header)) / Math.max(1, bottom(r) - bottom(header))
    if (groupOnly || group.context) target.edge = point.y < r.y + r.height / 2 ? 'top' : 'bottom'
    else if (point.y >= bottom(header)) target.edge = y < .3 ? 'top' : y > .7 ? 'bottom' : undefined
    else target.beforeView = nextItem(group, point.x)
    rect = { x: r.x - bounds.x + 4, y: r.y - bounds.y + 4, width: r.width - 8, height: header.height - 8 }
    if (target.edge) {
      rect.height = r.height / 2 - 8
      if (target.edge === 'bottom') rect.y += r.height / 2
    }
  }
  return { target, rect }
}

export function hitEditorDrop(groups: GroupGeometry[], point: Point, eventGroup?: string): { group: string; edge?: EditorEdge; before?: string } | undefined {
  const g = groups.find(g => g.id === eventGroup) ?? groups.find(({ rect: r }) => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= bottom(r))
  if (!g) return
  if (point.y < bottom(g.header)) return { group: g.id, before: nextItem(g, point.x) }
  const r = g.rect, x = (point.x - r.x) / r.width, y = (point.y - r.y) / r.height
  const distances: [EditorEdge, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
  const [edge, distance] = distances.sort((a, b) => a[1] - b[1])[0]
  return { group: g.id, edge: distance < .23 ? edge : undefined }
}
