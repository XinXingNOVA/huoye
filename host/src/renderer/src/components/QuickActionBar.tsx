import { useRef, useState, type ReactNode } from 'react'
import type { UiHost } from '../plugin'
import type { CommandSession, QuickActionIcon } from '../../../plugin-api/ui/commands'
import { uiCommands } from '../ui-registry'
import { acceleratorLabel } from '../widgets'
import { LayoutIcon, QuickActionIconView, SettingsIcon, VaultIcon } from './icons'

const fixed: { id: string; title: string; icon: QuickActionIcon }[] = [
  { id: 'host.view.all', title: '全部视图', icon: 'grid' },
  { id: 'host.library.create-text', title: '新建文字', icon: 'text' },
  { id: 'host.library.import', title: '导入文件', icon: 'import' }
]
/** 快捷动作不是工具位置目录；执行走命令会话，来源在点击时捕获。 */
export function QuickActionBar(p: {
  host: UiHost
  libraryTitle: string
  status: ReactNode
  layoutOpen?: boolean
  onCommand(): void
  onLayout(): void
}) {
  const [busy, setBusy] = useState(false), running = useRef(false)
  const plugins = uiCommands().filter(c => c.quickAction).sort((a, b) => (a.quickAction!.order ?? 100) - (b.quickAction!.order ?? 100) || a.id.localeCompare(b.id))
  const execute = async (id: string) => {
    if (running.current) return
    running.current = true; setBusy(true)
    let session: CommandSession | undefined
    try { session = p.host.commands.createSession({ ids: [id] }); await session.execute(id) }
    catch (error) { p.host.notify(error instanceof Error ? error.message : String(error)) }
    finally { session?.dispose(); running.current = false; setBusy(false) }
  }
  return <nav className="activity-bar" aria-label="常用操作" onKeyDown={e => e.stopPropagation()}>
    <div className="activity-items">
      {fixed.map(c => <button key={c.id} className="activity-entry" data-quick-action={c.id} aria-label={c.title} title={c.title} disabled={busy} onClick={() => void execute(c.id)}><QuickActionIconView name={c.icon}/></button>)}
      <button className="activity-entry" title={`命令面板（${acceleratorLabel('CmdOrCtrl+P')}）`} aria-label="打开命令面板" onMouseDown={e => e.preventDefault()} onClick={p.onCommand}><QuickActionIconView name="command"/></button>
      {!!plugins.length && <div className="quick-action-divider" role="separator"/>}
      {plugins.map(c => <button key={c.id} className="activity-entry" data-quick-action={c.id} aria-label={c.title} title={`${c.title} · ${c.category}`} disabled={busy} onClick={() => void execute(c.id)}><QuickActionIconView name={c.quickAction?.icon}/></button>)}
    </div>
    <div className="activity-status">{p.status}</div>
    <button className="activity-entry" title={p.libraryTitle + ' · 切换仓库'} aria-label="切换仓库" onClick={() => void window.bridge.vaults.show().catch(e => p.host.notify(String(e)))}><VaultIcon size={18}/></button>
    <button className={`activity-entry${p.layoutOpen ? ' is-open' : ''}`} title="工作台布局与工具" aria-label="工作台布局" aria-expanded={p.layoutOpen} onClick={p.onLayout}><LayoutIcon size={18}/></button>
    <button className="activity-entry" title="设置" aria-label="打开设置" onClick={() => void p.host.openSettings().catch(e => p.host.notify(String(e)))}><SettingsIcon size={18}/></button>
  </nav>
}
