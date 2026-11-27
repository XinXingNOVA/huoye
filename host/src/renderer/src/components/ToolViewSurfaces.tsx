import { ToolContent } from './ToolContent'
import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { ContentDropBoundary } from '../content-drop'
import type { ReactNode } from 'react'
import type { PageContext, UiHost } from '../plugin'
import type { SidebarCatalog } from '../sidebar-catalog'
import { activeView } from '../sidebar-layout'
import { describeTools, contentPlacementReason } from '../workbench-content'
import { groupOf } from '../editor-layout'
import { toolIdOf, type Workspace } from '../workspace'
import { RetainedSurface } from './RetainedSurface'
import { surfaceSlot } from '../surface-slots'
import { BoundToolView } from './BoundToolView'

/** 唯一实例所有者。左右栏和中央只是插槽，跨区域不更换 React 树。 */
export function ToolViewSurfaces(p: { workspace: Workspace; catalog: SidebarCatalog; host: UiHost; contexts: PageContext[]; hostForPage(id: string): UiHost; onLocate(id: string): void; onClose(id: string): void; builtin: Record<string, ReactNode> }) {
  useUiLocale()
  const { workspace: w } = p, layout = w.sidebars!, views = describeTools(w, p.catalog)
  return <>{views.map(v => {
    const tab = w.tabs.find(t => toolIdOf(t) === v.id), group = tab && groupOf(w, tab.id)
    const c = layout.containers.find(c => c.views.includes(v.id)), selected = !!c && activeView(layout, c, views) === v.id
    const active = group ? group.active === tab!.id : !!c && w.panels[c.side === 'left' ? 'sidebar' : 'inspector'] && selected
    const Content = v.Component
    const blocked = group ? !v.available ? uiText("工具暂不可用") : contentPlacementReason(v, 'center') : !v.available && !v.binding ? uiText("工具插件暂不可用") : undefined
    const slot = active ? group ? surfaceSlot('editor', group.id) : surfaceSlot('sidebar', c!.id) : undefined
    return <RetainedSurface key={v.id} className="tool-view-content dock-content" slot={slot} visible={active}>
      <ContentDropBoundary title={v.title} query={v.dropQuery} enabled={active && !blocked && !v.binding}>
        <div className="tool-view-body" id={`tool-panel-${encodeURIComponent(v.id)}`} role="tabpanel" aria-label={v.title} data-panel-content={v.id}
          onPointerDownCapture={e => { if (tab && e.button !== 1) p.onLocate(tab.id) }} onFocusCapture={() => { if (tab) p.onLocate(tab.id) }}
          onKeyDown={e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation() }}>
          {blocked ? <div className="context-tool-empty">{blocked}</div> : v.binding ? <BoundToolView sourcePreset={v.sourcePreset} showSource={!!group} binding={v.binding} tool={p.catalog.contextTools.find(t => t.id === v.binding!.toolId)} context={p.contexts.find(c => c.pageId === v.binding!.pageId)} hostForPage={p.hostForPage} active={active} onLocate={p.onLocate} onClose={() => p.onClose(v.id)}/> : Content ? <ToolContent id={v.id} Component={Content} host={p.host} active={active}/> : p.builtin[v.id]}
        </div>
      </ContentDropBoundary>
    </RetainedSurface>
  })}</>
}
