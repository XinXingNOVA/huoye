import type { EntityView } from '../../shared/blocks'

export const ENTITY_DRAG_TYPE = 'application/x-rm-entities'
/** 小型结构契约使拖拽分支可独立验证，Electron 和 React 事件留在宿主适配处。 */
export interface DragGesture {
  preventDefault(): void
  dataTransfer: { setData(type: string, data: string): void; effectAllowed: string }
}
export function startEntityDrag(
  event: DragGesture,
  ids: string[],
  viewOf: (id: string) => EntityView | undefined,
  outputOf: (view: EntityView) => { file: string; icon?: string } | undefined,
  startNative: (files: string[], icon?: string) => void
): void {
  if (!ids.length) { event.preventDefault(); return }
  const outs = ids.map((id) => { const view = viewOf(id); return view && outputOf(view) })
  if (outs.every((out) => out)) {
    event.preventDefault()
    startNative(outs.map((out) => out!.file), outs[0]!.icon)
  } else {
    event.dataTransfer.setData(ENTITY_DRAG_TYPE, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'copyMove'
  }
}
