import { useMemo } from 'react'
import { ResourceCollection, type CollectionParams, type CollectionState, type CollectionToolbarProps } from '@resource-manager/plugin-api/ui/collection'
import { ResourceBadge } from '@resource-manager/plugin-api/ui/media'
import type { NavProps, TabProps, TabType, ViewProps } from '@resource-manager/plugin-api/ui/contracts'
import { useFileEditing, editingLabel } from './state'
import { FileEditingControls, showEditing } from './editing'

export const EDITING_VIEW: CollectionParams = { title: '编辑中', query: { scope: 'content' }, layout: 'masonry' }
export function FileEditingNav({ host }: NavProps) {
  const { tasks } = useFileEditing()
  return <button className="nav-item" title="当前仓库在这台电脑上的工作副本" onClick={() => host.openTab('file-editing.page', EDITING_VIEW)}>编辑中{tasks.length ? ` · ${tasks.length}` : ''}</button>
}
export function FileEditingBadge({ view }: ViewProps) {
  const task = useFileEditing().tasks.find(t => t.itemId === view.id)
  return task ? <ResourceBadge>{editingLabel(task)}</ResourceBadge> : null
}
function EditingToolbar({ selected, host }: CollectionToolbarProps) {
  const state = useFileEditing()
  return <div className="editing-view-bar">
    {selected.length === 1 ? <FileEditingControls id={selected[0]} host={host} onlyActive /> : <span className="muted">{state.ready && !state.tasks.length ? '没有正在编辑的文件。可以从素材右键菜单开始编辑。' : '双击继续编辑；选中一项后完成编辑。普通查看仍使用本库已接纳版本。'}</span>}
    {state.error && <p className="file-editing-error" role="alert">{state.error}<button onClick={() => void state.refresh()}>重试读取</button></p>}
  </div>
}
function EditingView(props: TabProps<CollectionParams, CollectionState>) {
  const state = useFileEditing()
  const ids = useMemo(() => [...new Set(state.tasks.map(t => t.itemId))], [state.tasks])
  const recovery = state.tasks.filter(t => t.ended || state.unavailable.includes(t))
  return <ResourceCollection {...props} scopeIds={ids} Toolbar={EditingToolbar} onOpen={id => props.host.editFile(id)}
    beforeItems={!!recovery.length && <details className="editing-recovery" open><summary>需要单独处理的工作副本 · 素材不可用或旧任务已结束</summary>{recovery.map(task => <button key={task.id} className="small" onClick={() => showEditing(props.host, task)}>{task.name} · {editingLabel(task)}</button>)}</details>} />
}
export const editingTabType: TabType<CollectionParams, CollectionState> = {
  id: 'file-editing.page', key: () => 'editing', Title: () => <>编辑中</>, Component: EditingView,
  inputs: { receive: false, create: false, reason: '“编辑中”按工作副本状态汇集素材；请到普通视图收录或新建素材' }
}
