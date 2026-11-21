import type { LabelKey } from '../../../shared/i18n'
import { t, useLanguage } from '../language'
import { useState } from 'react'
import type { SettingsPage } from '../../../plugin-api/ui/settings'
import { SearchCommandIcon, SettingSectionIcon } from './icons'

export const isFeatureSection = (id: string) => ['plugins', 'plugin-presets', 'development'].includes(id)
export const isLocalSection = (id: string) => id === 'spaces' || id === 'editors'

const appTitles: Record<string, LabelKey | undefined> = { appearance: 'settings.appearance', language: 'common.language', packages: 'settings.packages', 'mcp.connection': 'settings.mcp' }
const libraryTitles: Record<string, LabelKey | undefined> = { import: 'settings.imports', maintenance: 'settings.maintenance', 'library-appearance': 'settings.libraryAppearance' }
function navigationEntry(page: SettingsPage) {
  if (page.scope === 'library' && page.category === 'appearance') return { id: 'library-appearance', title: t('settings.libraryAppearance') }
  if (page.scope === 'library' && !page.pluginId && isFeatureSection(page.id)) return { id: 'plugins', title: t('settings.features') }
  if (page.scope === 'application' && isLocalSection(page.id)) return { id: 'spaces', title: t('common.spacesApps') }
  const key = page.scope === 'application' ? appTitles[page.id] : !page.pluginId ? libraryTitles[page.id] : undefined
  return key ? { id: page.id, title: t(key) } : page
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
  useLanguage()
  const [search, setSearch] = useState('')
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const groups = [
    { title: t('settings.library'), className: 'settings-library-nav', label: t('settings.libraryNav'), pages: pages.filter(p => p.scope === 'library' && (!p.pluginId || p.category === 'appearance')) },
    { title: t('settings.plugin'), className: 'settings-plugins-nav', label: t('settings.pluginNav'), pages: pages.filter(p => p.scope === 'library' && p.pluginId && p.category !== 'appearance') },
    { title: t('settings.app'), className: 'application-settings-nav', label: t('settings.appNav'), pages: pages.filter(p => p.scope === 'application') }
  ].map(group => ({
    ...group,
    rows: navigationRows(group.pages, terms, group.pages[0]?.scope === scope ? section : undefined)
  })).filter(group => group.rows.length > 0)
  return (
    <aside className="settings-sidebar">
      <div className="settings-search-wrap">
        <SearchCommandIcon size={14} />
        <input type="search" className="settings-search-input" placeholder={t('settings.search')} aria-label={t('settings.searchLabel')}
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="settings-nav-scroll">
        {groups.map(group => (
          <div className="settings-nav-group" key={group.className}>
            <div className="settings-nav-group-title">{group.title}</div>
            <div className={group.className} role="group" aria-label={group.label}>
              {group.rows.map(({ id, title, target, active, subtitle }) => (
                <button key={id} type="button" aria-pressed={active} onClick={() => navigate(target.scope, target.id)}>
                  <SettingSectionIcon id={id} isPlugin={!!target.pluginId && target.category !== 'appearance'} />
                  <span className="settings-nav-item-label">{title}</span>
                  {subtitle && <small className="settings-nav-plugin-badge">{subtitle}</small>}
                  {target.scope === 'library' && target.pluginTitle && target.pluginTitle !== target.title && (terms.length > 0 || target.category !== 'appearance') &&
                    <span className="settings-nav-plugin-badge">{target.pluginTitle}</span>}
                  {target.scope === 'library' && id === 'plugins' && dirty &&
                    <span className="settings-dirty-dot" title={t('settings.dirty')} />}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="muted">{t('settings.empty')}</p>}
      </div>
    </aside>
  )
}
