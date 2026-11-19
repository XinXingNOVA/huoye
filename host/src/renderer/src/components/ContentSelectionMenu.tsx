import { DisplayPortal } from '../DisplayPortal'
import { displayDocument } from '../display-windows'
import { useEffect, useRef, useState } from 'react'
import type { UiHost } from '../plugin'
import { selectionActions } from '../ui-registry'
import { useContentSelection, type SelectionAction, type ContentSelection } from '../../../plugin-api/ui/selection'
const copy: SelectionAction = { id: 'host.copy-selection', title: '复制', order: 100, run: async ({ selection }) => navigator.clipboard.writeText(selection.text) }
export function ContentSelectionMenu({ host }: { host: UiHost }) {
  const running = useRef(false)
  const value = useContentSelection(host)
  const [busy, setBusy] = useState(false), [more, setMore] = useState(false)
  useEffect(() => { setMore(false) }, [value?.id])
  if (!value) return null
  const actions = [...selectionActions(), copy].flatMap(action => {
    try {
      return !action.when || action.when(value, host) ? [{ action, disabled: action.disabled?.(value, host) }] : []
    } catch (error) {
      console.error(`选区操作 ${action.id} 判断失败`, error)
      return [{ action, disabled: '插件暂时无法使用此操作' }]
    }
  }).sort((a, b) => a.action.order - b.action.order)
  const run = async (action: SelectionAction, snapshot: ContentSelection) => {
    if (running.current || !host.selection.valid(snapshot)) return
    running.current = true; setBusy(true)
    try {
      await action.run({ host, selection: snapshot, valid: () => host.selection.valid(snapshot), select: id => host.selection.select(snapshot, id) })
      host.selection.clear(snapshot.id)
    } catch (e) { host.notify(`操作失败：${e instanceof Error ? e.message : String(e)}`) }
    finally { running.current = false; setBusy(false) }
  }
  const doc = displayDocument(), win = doc.defaultView!
  return <DisplayPortal doc={doc}><div className="content-selection-menu" data-content-selection-ui role="toolbar" aria-label="选中文字的操作"
    style={{ left: Math.max(8, Math.min(value.rect.left, win.innerWidth - 330)), top: Math.max(8, Math.min(value.rect.top + value.rect.height + 8, win.innerHeight - 100)) }}
    onMouseDown={e => e.preventDefault()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') host.selection.clear(value.id) }}>
    {(more ? actions : actions.slice(0, 3)).map(({ action, disabled }) => <button key={action.id} disabled={busy || !!disabled} title={disabled} onClick={() => void run(action, value)}>{action.title}</button>)}
    {actions.length > 3 && <button aria-expanded={more} onClick={() => setMore(v => !v)}>{more ? '收起' : '更多…'}</button>}
    <button aria-label="关闭选区操作" onClick={() => host.selection.clear(value.id)}>×</button>
  </div></DisplayPortal>
}
