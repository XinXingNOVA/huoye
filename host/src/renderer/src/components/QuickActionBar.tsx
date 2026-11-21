import { t, useLanguage } from '../language'
import { useRef, useState, type ReactNode } from 'react'
import { DropdownMenu } from '../../../plugin-api/ui/kit'
import type { UiHost } from '../plugin'
import type { CommandSession, QuickActionIcon } from '../../../plugin-api/ui/commands'
import { uiCommands } from '../ui-registry'
import { acceleratorLabel } from '../widgets'
import { LayoutIcon, QuickActionIconView, SettingsIcon, VaultIcon } from './icons'

const fixed: { id: string; title: import('../../../shared/i18n').LabelKey; icon: QuickActionIcon }[] = [
  { id: 'host.view.all', title: 'workbench.allViews', icon: 'grid' },
  { id: 'host.library.create-text', title: 'workbench.newText', icon: 'text' },
  { id: 'host.library.import', title: 'workbench.import', icon: 'import' }
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
  useLanguage()
  const [busy, setBusy] = useState(false), running = useRef(false)
  const [importAnchor, setImportAnchor] = useState<HTMLButtonElement | null>(null)
  const plugins = uiCommands().filter(c => c.quickAction).sort((a, b) => (a.quickAction!.order ?? 100) - (b.quickAction!.order ?? 100) || a.id.localeCompare(b.id))
  const execute = async (id: string) => {
    if (running.current) return
    running.current = true; setBusy(true)
    let session: CommandSession | undefined
    try { session = p.host.commands.createSession({ ids: [id] }); await session.execute(id) }
    catch (error) { p.host.notify(error instanceof Error ? error.message : String(error)) }
    finally { session?.dispose(); running.current = false; setBusy(false) }
  }
  return <nav className="activity-bar" aria-label={t('workbench.quick')} onKeyDown={e => e.stopPropagation()}>
    <div className="activity-items">
      {fixed.map(c => <button key={c.id} className="activity-entry" data-quick-action={c.id} aria-label={t(c.title)} title={t(c.title)} disabled={busy}
        aria-haspopup={c.icon === 'import' ? 'menu' : undefined} aria-expanded={c.icon === 'import' ? !!importAnchor : undefined}
        onClick={e => c.icon === 'import' ? setImportAnchor(e.currentTarget) : void execute(c.id)}><QuickActionIconView name={c.icon}/></button>)}
      {importAnchor && <DropdownMenu anchor={importAnchor} label={t('workbench.importMode')} groups={[{ items: [
        { id: 'host.library.import', label: t('workbench.managedImport') },
        { id: 'host.library.link-folder', label: t('workbench.linkFolder') }
      ] }]} onClose={() => setImportAnchor(null)} onSelect={id => void execute(id)}/>}

      <button className="activity-entry" title={t('workbench.paletteHint', { shortcut: acceleratorLabel('CmdOrCtrl+P') })} aria-label={t('workbench.palette')} onMouseDown={e => e.preventDefault()} onClick={p.onCommand}><QuickActionIconView name="command"/></button>
      {!!plugins.length && <div className="quick-action-divider" role="separator"/>}
      {plugins.map(c => <button key={c.id} className="activity-entry" data-quick-action={c.id} aria-label={c.title} title={`${c.title} · ${c.category}`} disabled={busy} onClick={() => void execute(c.id)}><QuickActionIconView name={c.quickAction?.icon}/></button>)}
    </div>
    <div className="activity-status">{p.status}</div>
    <button className="activity-entry" title={p.libraryTitle + ' · ' + t('workbench.switch')} aria-label={t('workbench.switch')} onClick={() => void window.bridge.vaults.show().catch(e => p.host.notify(String(e)))}><VaultIcon size={18}/></button>
    <button className={`activity-entry${p.layoutOpen ? ' is-open' : ''}`} title={t('workbench.layoutTools')} data-workbench-layout-trigger aria-label={t('workbench.layout')} aria-expanded={p.layoutOpen} onClick={p.onLayout}><LayoutIcon size={18}/></button>
    <button className="activity-entry" title={t('common.settings')} aria-label={t('workbench.openSettings')} onClick={() => void p.host.openSettings().catch(e => p.host.notify(String(e)))}><SettingsIcon size={18}/></button>
  </nav>
}
