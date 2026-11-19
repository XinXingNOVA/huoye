import { blurDisplayInputs } from '../display-windows'
import { useMemo } from 'react'
import { dockSourceReason, placeToolContent, resolveToolPlacement, type DockSource, type DockTarget } from '../workbench-placement'
import { pageContext } from '../page-context'
import { measurePlacement } from '../components/workbench-geometry'
import type { SidebarCatalog } from '../sidebar-types'
import type { Workspace } from '../workspace'
import type { PageAccess } from './page-access'

interface Options {
  detach(value: DockSource, point?: { x: number; y: number }): Promise<void>
  read(): Workspace | undefined
  update(fn: (w: Workspace) => Workspace): void
  catalog: SidebarCatalog
  pages: PageAccess
  transitions: { readonly busy: boolean }
  notify(message: string): void
}
/** 只协调上下文、测量和提交；工作区状态仍由 useWorkspace 唯一持有。 */
export function useWorkspaceDocking({ read, update, catalog, pages, transitions, notify, detach }: Options) {
  return useMemo(() => {
    const context = (value: DockSource) => value.type === 'context-tool' ? pageContext(pages, value.pageId) : undefined
    return {
      detach,
      reason(value: DockSource, region: 'left' | 'center' | 'right') {
        const w = read()
        return !w || transitions.busy ? '工作区正在切换' : dockSourceReason(w, catalog, value, region, context(value))
      },
      preview(value: DockSource, target: DockTarget, sideHeight?: number) {
        const w = read()
        if (!w || transitions.busy) return '工作区正在切换'
        return resolveToolPlacement(w, catalog, value, target, context(value), { ...measurePlacement(w, target), ...(sideHeight === undefined ? {} : { sideHeight }) }).blocked
      },
      place(value: DockSource, target: DockTarget) {
        const w = read()
        if (!w || transitions.busy) { notify('工作区正在切换'); return }
        const blocked = resolveToolPlacement(w, catalog, value, target, context(value), measurePlacement(w, target)).blocked
        if (blocked) { notify(blocked); return }
        blurDisplayInputs()
        update(current => transitions.busy ? current : placeToolContent(current, catalog, value, target, context(value), measurePlacement(current, target)))
      }
    }
  }, [read, catalog, pages, update, notify, transitions, detach])
}
export type WorkspaceDocking = ReturnType<typeof useWorkspaceDocking>
