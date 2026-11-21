import { uiText } from '../../../shared/i18n/interface-display'
import { t as message, useLanguage, viewTitle } from '../language'
import type { DragEvent, HTMLAttributes } from 'react'
import { acceleratorLabel } from '../widgets'
import type { UiHost } from '../plugin'
import type { WorkbenchContent } from '../workbench-content'
import type { TabEntry } from '../workspace'
import { TabTypeIcon } from './icons'

interface Props {
  tabs: TabEntry[]
  active: string
  host: UiHost
  describe(entry: TabEntry): WorkbenchContent
  dropTarget?: string
  onSelect(id: string): void
  onClose(id: string): void
  onNew(): void
  onTabMenu(id: string): void
  onDragStart(e: DragEvent, id: string): void
  onDragEnd(e: DragEvent): void
  dropProps(id: string): HTMLAttributes<HTMLDivElement>
}

export function TabBar({ tabs, active, host, describe, dropTarget, onSelect, onClose, onNew, onTabMenu, onDragStart, onDragEnd, dropProps }: Props) {
  useLanguage()
  return (
    <div className="tabbar" role="tablist" aria-label={uiText("本组标签页")}>
      {tabs.map((t, i) => {
        const content = describe(t), type = content.kind === 'page' ? content.definition : undefined
        const title = content.kind === 'tool' && content.binding && content.typeId === 'host.filters'
          ? message('section.pinnedFilter', { page: viewTitle(content.sourcePreset, content.binding.pageTitle) })
          : content.title
        return (
          <div
            key={t.id}
            data-tab={t.id}
            role="tab" tabIndex={t.id === active ? 0 : -1} aria-selected={t.id === active}
            draggable onDragStart={e => onDragStart(e, t.id)} onDragEnd={onDragEnd}
            onContextMenu={e => { e.preventDefault(); onTabMenu(t.id) }}
            onFocus={e => { if (e.target === e.currentTarget) onSelect(t.id) }}
            onKeyDown={e => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSelect(t.id) }
              const index = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1
              if (index >= 0) { e.preventDefault(); e.stopPropagation(); onSelect(tabs[index].id); e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(tabs[index].id)}"]`)?.focus() }
            }}
            {...dropProps(t.id)}
            className={`tab${t.id === active ? ' active' : ''}${t.id === dropTarget ? ' drop' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) { e.preventDefault(); onClose(t.id) }
              else if (e.button === 0) onSelect(t.id)
            }}
            title={i < 9 ? acceleratorLabel(`CmdOrCtrl+${i + 1}`) : undefined}
          >
            <TabTypeIcon type={t.type} params={t.params} />
            <span className="tab-title">{type ? <type.Title params={t.params} host={host} /> : title}</span>
            <button
              className="tab-x"
              aria-label={uiText("关闭标签页")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose(t.id)}
              title={uiText("关闭标签页（{value1}）", { value1: String(acceleratorLabel('CmdOrCtrl+W')) })}
            >
              ×
            </button>
          </div>
        )
      })}
      <button className="tab-new" aria-label={uiText("新建标签页")} onClick={onNew} title={uiText("新建标签页（{value1}）", { value1: String(acceleratorLabel('CmdOrCtrl+T')) })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  )
}
