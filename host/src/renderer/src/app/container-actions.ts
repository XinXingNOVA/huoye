import { displayWindows } from '../display-windows'
import { useMemo } from 'react'
import { measureSidebarHeight } from '../components/workbench-geometry'
import { applyContainerAction, type ContainerAction, type ContainerActionResult, type ContextChange, type ContextTarget } from '../container-actions'
import { pageContext } from '../page-context'
import type { SidebarCatalog } from '../sidebar-types'
import type { SidebarSide } from '../sidebar-layout'
import type { Workspace } from '../workspace'
import type { PageAccess } from './page-access'

interface Options {
  read(): Workspace | undefined
  update(fn: (w: Workspace) => Workspace): void
  catalog: SidebarCatalog
  pages: PageAccess
  transitions: { readonly busy: boolean }
  activate(id: string): void
  notify(message: string): void
}
export function useContainerActions({ read, update, catalog, pages, transitions, activate, notify }: Options) {
  return useMemo(() => {
    const perform = (action: ContainerAction): boolean => {
      if (!read() || transitions.busy) return false
      // 与原侧栏操作一致，先提交失焦式输入；宽度拖动不改变内容显隐。
      if (action.type !== 'resize-region') for (const win of displayWindows()) {
        const el = win.document.activeElement as HTMLElement | null
        if (el && (action.type === 'close-tool' || el.closest('.tool-view-content'))) el.blur?.()
      }
      let result: ContainerActionResult | undefined
      update(w => {
        if (transitions.busy) return w
        result = applyContainerAction(w, catalog, action, {
          context: action.type === 'context' ? pageContext(pages, action.source.pageId) : action.type === 'show-tool' ? pageContext(pages, w.active) : undefined,
          height: action.type === 'add-context' ? measureSidebarHeight(action.side) : undefined
        })
        return result.workspace
      })
      if (result?.blocked) notify(result.blocked)
      else if (result?.focus) activate(result.focus)
      return !!result && !result.blocked
    }
    return {
      showTool: (id: string) => perform({ type: 'show-tool', id }),
      closeTool: (id: string) => perform({ type: 'close-tool', id }),
      resetTool: (id: string) => perform({ type: 'reset-tool', id }),
      reorderTool: (id: string, group: string, direction: -1 | 1) => perform({ type: 'reorder-tool', id, group, direction }),
      closeGroup: (id: string) => perform({ type: 'close-group', id }),
      reorderGroup: (id: string, direction: -1 | 1) => perform({ type: 'reorder-group', id, direction }),
      addContext: (side: SidebarSide) => perform({ type: 'add-context', side }),
      configureContext: (id: string, source: ContextTarget, change: ContextChange) => perform({ type: 'context', id, source, change }),
      resizeGroups: (first: string, second: string, ratio: number) => perform({ type: 'resize-groups', first, second, ratio }),
      setVisible: (side: SidebarSide, visible: boolean) => perform({ type: 'set-visible', side, visible }),
      resizeRegion: (side: SidebarSide, size: number) => perform({ type: 'resize-region', side, size }),
      resetSidebars: () => perform({ type: 'reset-sidebars' })
    }
  }, [read, update, catalog, pages, transitions, activate, notify])
}
export type ContainerActions = ReturnType<typeof useContainerActions>
