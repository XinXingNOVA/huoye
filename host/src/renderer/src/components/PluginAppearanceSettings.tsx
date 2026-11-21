import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { useEffect, useRef } from 'react'
import { ListRow } from '../../../plugin-api/ui/kit'
import type { UiHost } from '../plugin'
import type { settingsSections } from '../ui-registry'
import { SettingGroup } from './ui-primitives'

export function PluginAppearanceSettings({ host, sections, active, navigate }: {
  host: UiHost; sections: ReturnType<typeof settingsSections>; active: string; navigate(section: string): void
}) {
  useUiLocale()
  const selected = useRef<HTMLElement>(null)
  useEffect(() => { selected.current?.scrollIntoView({ block: 'nearest' }) }, [active])
  return <SettingGroup title={uiText("插件外观")}>
    {sections.map(({ id, title, pluginTitle, description, scope, Component }) => {
      const expanded = active === id
      const label = title === pluginTitle ? title : `${pluginTitle} · ${title}`
      return <section key={id} ref={expanded ? selected : undefined} aria-label={label} data-settings-section={id}>
        <ListRow title={label} icon={expanded ? 'down' : 'right'} aria-expanded={expanded}
          onClick={() => navigate(expanded ? 'library-appearance' : id)} />
        {expanded && <>
          {description && <p className="muted plugin-settings-card-desc">{description}</p>}
          {scope === 'library' && <p className="muted plugin-settings-card-desc">{uiText("保存在仓库")}</p>}
          <Component host={host} />
        </>}
      </section>
    })}
  </SettingGroup>
}
