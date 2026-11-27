import { uiText } from '../../../shared/i18n/interface-display'
import { useMemo, useRef } from 'react'
import { prepareAuxiliarySurface, discardAuxiliarySurface } from '../auxiliary-surface'
import { blurDisplayInputs } from '../display-windows'
import { detachEditor, editorsOf, returnEditorWindow } from '../editor-layout'
import { dockSourceReason, placeToolContent, type DockSource } from '../workbench-placement'
import { pageContext } from '../page-context'
import { toolIdOf, type Workspace } from '../workspace'
import type { SidebarCatalog } from '../sidebar-types'
import type { ContentWindowState } from '../../../shared/auxiliary-windows'
import type { PageAccess } from './page-access'

interface Options {
  read(): Workspace | undefined
  update(change: (w: Workspace) => Workspace): void
  catalog: SidebarCatalog
  pages: PageAccess
  transitions: { readonly busy: boolean }
  notify(message: string): void
}
/** 先准备原生窗口，再一次提交位置；失败不移走原内容。 */
export function useWorkspaceWindows({ read, update, catalog, pages, transitions, notify }: Options) {
  const moving = useRef(new Set<string>())
  return useMemo(() => {
    const context = (source: DockSource) => source.type === 'context-tool' ? pageContext(pages, source.pageId) : undefined
    const move = async (key: string, prepare: (w: Workspace) => Workspace, point?: Partial<ContentWindowState>) => {
      if (transitions.busy || moving.current.has(key)) return
      const current = read(); if (!current) return
      const group = `editor-${crypto.randomUUID()}`, kind = `content:${group}` as const
      moving.current.add(key)
      try {
        prepare(current) // 在创建窗口前检查能力；提交前仍以最新状态复核。
        blurDisplayInputs()
        await prepareAuxiliarySurface(kind, point)
        let moved = false
        update(w => {
          if (transitions.busy) return w
          const ready = prepare(w)
          moved = true
          return detachEditor(ready, ready.active, group, point, editorsOf(w))
        })
        if (!moved) await discardAuxiliarySurface(kind)
      } catch (error) { await discardAuxiliarySurface(kind); notify(String(error)) }
      finally { moving.current.delete(key) }
    }
    return {
      openFloating: move,
      detachPage(id: string, point?: { x: number; y: number }) {
        return move(id, w => {
          const tab = w.tabs.find(t => t.id === id)
          if (!tab) throw new Error(uiText("页面已关闭"))
          const tool = toolIdOf(tab), blocked = tool && dockSourceReason(w, catalog, { type: 'view', id: tool }, 'center')
          if (blocked) throw new Error(blocked)
          return { ...w, active: id }
        }, point)
      },
      detachTool(source: DockSource, point?: { x: number; y: number }) {
        return move(`${source.type}:${source.id}`, w => {
          const blocked = dockSourceReason(w, catalog, source, 'center', context(source))
          if (blocked) throw new Error(blocked)
          return placeToolContent(w, catalog, source, { region: 'center' }, context(source))
        }, point)
      },
      returnGroup(group: string) { if (!transitions.busy) update(w => returnEditorWindow(w, group)) },
      bounds(group: string, bounds: ContentWindowState) {
        if (!transitions.busy) update(w => ({ ...w, editors: { ...editorsOf(w), groups: editorsOf(w).groups.map(g => g.id === group && g.window ? { ...g, window: bounds } : g) } }))
      }
    }
  }, [read, update, catalog, pages, transitions, notify])
}
