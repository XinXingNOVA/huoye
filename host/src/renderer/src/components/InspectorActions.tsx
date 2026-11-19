import { actionsFor, openersFor, tabTypeOf } from '../ui-registry'
import type { EntityView } from '../../../shared/blocks'
import type { UiHost, ActionDef } from '../plugin'
import type { PageAccess } from '../app/page-access'
import { sameContent } from '../page-instances'
import { QuickActionIconView } from './icons'

export function InspectorAction({ action, views, host }: { action: ActionDef; views: EntityView[]; host: UiHost }) {
  const title = typeof action.title === 'function' ? action.title(views) : action.title
  return <button className="inspector-action-icon" data-action-id={action.id} title={title} aria-label={title}
    onClick={() => void Promise.resolve().then(() => action.run(views, host)).catch(e => host.notify(String(e)))}><QuickActionIconView name={action.icon} /></button>
}

/** 只比较打开器声明的页面内容身份；集合中的选中项不是已打开页面。回调型打开器不能推断，不执行它来探测。 */
export function openedResource(view: EntityView, pages: PageAccess) {
  const targets = openersFor(view).flatMap(({ contribution: o }) => 'tab' in o ? [{ id: '', type: o.tab, params: o.params(view) }] : [])
  targets.push({ id: '', type: 'data.details', params: { id: view.id } })
  const matches = pages.entries().filter(entry => targets.some(target => {
    const rule = tabTypeOf(target.type)
    return rule && sameContent(rule, entry, target)
  }))
  return matches.find(t => t.id === pages.active()) ?? matches[0]
}

export function InspectorActions({ views, host, pages, onLocate }: { views: EntityView[]; host: UiHost; pages?: PageAccess; onLocate?(id: string): void }) {
  const actions = [...actionsFor(views).byId.values()]
  if (!actions.length) return null
  const primary = actions.find(a => a.inspector === 'primary' && !a.danger)
  const shortcuts = actions.filter(a => a.inspector === 'shortcut' && !a.danger).slice(0, 3)
  const opened = primary?.id === 'open' && views.length === 1 && pages ? openedResource(views[0], pages) : undefined
  const current = !!opened && opened.id === pages?.active()
  const title = opened ? current ? '正在查看' : '定位到页面' : primary && (typeof primary.title === 'function' ? primary.title(views) : primary.title)
  return <div className="inspector-actions" role="group" aria-label="素材操作">
    {primary && <button className={`inspector-primary small${current ? '' : ' primary'}`} data-action-id={primary.id} disabled={current} title={title}
      onClick={() => { if (opened && onLocate) onLocate(opened.id); else void Promise.resolve().then(() => primary.run(views, host)).catch(e => host.notify(String(e))) }}>{title}</button>}
    {shortcuts.map(action => <InspectorAction key={action.id} action={action} views={views} host={host} />)}
    <button className="inspector-more" aria-label="更多素材操作" title="更多素材操作" aria-haspopup="menu" onClick={() => host.showActions(views.map(v => v.id))}>···</button>
  </div>
}
