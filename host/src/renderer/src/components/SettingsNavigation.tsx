import { useState } from 'react'
import type { SettingsPage } from '../../../plugin-api/ui/settings'
import { SearchCommandIcon, SettingSectionIcon } from './icons'

export const isFeatureSection = (id: string) => ['plugins', 'plugin-presets', 'development'].includes(id)
export const isLocalSection = (id: string) => id === 'spaces' || id === 'editors'

function navigationEntry(page: SettingsPage) {
  if (page.scope === 'library' && !page.pluginId && isFeatureSection(page.id)) return { id: 'plugins', title: '功能与方案' }
  if (page.scope === 'application' && isLocalSection(page.id)) return { id: 'spaces', title: '文件空间与外部应用' }
  return page
}

export const navigationTitle = (page: SettingsPage) => navigationEntry(page).title

function navigationRows(pages: SettingsPage[], terms: string[], activeSection?: string) {
  const entries = new Map<string, SettingsPage[]>()
  for (const page of pages) {
    const { id } = navigationEntry(page)
    const members = entries.get(id)
    if (members) members.push(page)
    else entries.set(id, [page])
  }
  return [...entries].flatMap(([id, members]) => {
    const title = navigationTitle(members[0])
    const match = (text: string) => terms.every(term => text.toLocaleLowerCase().includes(term))
    const keywords = (p: SettingsPage) => [p.title, p.description, p.pluginTitle, ...(p.keywords ?? [])].join(' ')
    const direct = members.filter(p => match(keywords(p)))
    const matches = direct.length ? direct : members.filter(p => match(title + ' ' + keywords(p)))
    const target = matches.find(p => p.id === activeSection) ?? matches[0]
    if (!target) return []
    const active = members.some(p => p.id === activeSection)
    const subtitle = terms.length && direct.length === 1 && members.length > 1 ? target.title : undefined
    return [{ id, title, target, active, subtitle }]
  })
}

/** 导航合并同一份草稿的入口，实际跳转仍使用原设置页 ID。 */
export function SettingsNavigation({ pages, scope, section, dirty, navigate }: {
  pages: readonly SettingsPage[]
  scope: SettingsPage['scope']
  section: string
  dirty?: boolean
  navigate(scope: SettingsPage['scope'], section: string): void
}) {
  const [search, setSearch] = useState('')
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const groups = [
    { title: '当前仓库', className: 'settings-library-nav', label: '当前仓库设置分类', pages: pages.filter(p => p.scope === 'library' && !p.pluginId) },
    { title: '插件设置', className: 'settings-plugins-nav', label: '插件设置分类', pages: pages.filter(p => p.scope === 'library' && p.pluginId) },
    { title: '全局应用', className: 'application-settings-nav', label: '应用设置分类', pages: pages.filter(p => p.scope === 'application') }
  ].map(group => ({
    ...group,
    rows: navigationRows(group.pages, terms, group.pages[0]?.scope === scope ? section : undefined)
  })).filter(group => group.rows.length > 0)
  return (
    <aside className="settings-sidebar">
      <div className="settings-search-wrap">
        <SearchCommandIcon size={14} />
        <input type="search" className="settings-search-input" placeholder="搜索设置…" aria-label="搜索设置"
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="settings-nav-scroll">
        {groups.map(group => (
          <div className="settings-nav-group" key={group.title}>
            <div className="settings-nav-group-title">{group.title}</div>
            <div className={group.className} role="group" aria-label={group.label}>
              {group.rows.map(({ id, title, target, active, subtitle }) => (
                <button key={id} type="button" aria-pressed={active} onClick={() => navigate(target.scope, target.id)}>
                  <SettingSectionIcon id={id} isPlugin={!!target.pluginId} />
                  <span className="settings-nav-item-label">{title}</span>
                  {subtitle && <small className="settings-nav-plugin-badge">{subtitle}</small>}
                  {target.scope === 'library' && target.pluginTitle && target.pluginTitle !== target.title &&
                    <span className="settings-nav-plugin-badge">{target.pluginTitle}</span>}
                  {target.scope === 'library' && id === 'plugins' && dirty &&
                    <span className="settings-dirty-dot" title="有未应用的更改" />}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="muted">没有匹配的设置</p>}
      </div>
    </aside>
  )
}
