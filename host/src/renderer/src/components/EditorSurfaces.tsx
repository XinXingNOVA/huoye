import type { ReactNode } from 'react'
import { groupOf } from '../editor-layout'
import { toolIdOf, type Workspace, type TabEntry } from '../workspace'
import { surfaceSlot } from '../surface-slots'
import { RetainedSurface } from './RetainedSurface'
/** 内容挂载独立于窗口外壳，移窗保持同一 Portal 与 React 实例。 */
export function EditorSurfaces({ workspace, alive, renderTab }: { workspace: Workspace; alive: Set<string>; renderTab(entry: TabEntry, visible: boolean): ReactNode }) {
  return <>{workspace.tabs.filter(t => !toolIdOf(t) && alive.has(t.id)).map(t => {
    const group = groupOf(workspace, t.id)!, visible = group.active === t.id
    return <RetainedSurface key={t.id} className="editor-surface" mountWhenHidden visible={visible} slot={surfaceSlot('editor', group.id)}>{renderTab(t, visible)}</RetainedSurface>
  })}</>
}
