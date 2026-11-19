import { mainWorkspace, mergeFloatingWorkspace } from '../editor-layout'
import { blurDisplayInputs } from '../display-windows'
import { resumePresetArrangement } from '../preset-arrangement-resume'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { arrangeWorkbench, captureWorkbenchArrangement, inspectWorkbenchArrangement, previewWorkbenchArrangement, type ArrangementReturnPoint } from '../workbench-arrangement'
import { createWorkbenchPresetService } from '../workbench-preset-service'
import { workbenchPresetCatalog, tabTypeOf } from '../ui-registry'
import { LayoutPresetStore, type WorkbenchLayout } from '../workbench-presets'
import type { SidebarCatalog } from '../sidebar-types'
import type { Workspace } from '../workspace'
import { type WorkbenchRequest, workbenchRevision } from '../../../shared/workbench-control'
import { localWorkbenchPages } from '../local-workbench'
import type { CoreClient } from '../core-client'

interface Options {
  core: Pick<CoreClient, 'get'>
  libraryId: string
  snapshot: Workspace | undefined
  read(): Workspace | undefined
  update(fn: (w: Workspace) => Workspace): void
  catalog: SidebarCatalog
  transitions: { readonly busy: boolean }
  releasePages(ids: string[]): void
  checkpoint(): Promise<void>
  notify(message: string): void
}
/** 预设与返回点的窗口级协调；不另存工作区，不拥有页面注册或草稿。 */
export function useWorkspacePresets({ core, libraryId, snapshot: ws, read, update, catalog, transitions, releasePages, checkpoint, notify }: Options) {
  const previousLayout = useRef<ArrangementReturnPoint>(undefined)
  const layoutActions = useMemo(() => {
    const environment = { page: tabTypeOf, catalog }
    const apply = (layout: WorkbenchLayout, returning?: ArrangementReturnPoint, receipt?: string, page = tabTypeOf) => {
      if (transitions.busy || !read()) return false
      // End blur-based edits before hiding their panel; no page is closed or replaced.
      blurDisplayInputs()
      const before = read()
      if (!before) return false
      const main = mainWorkspace(before), ids = new Set(main.tabs.map(t => t.id))
      const result = arrangeWorkbench(main, layout, { ...environment, page, retained: before.tabs.filter(t => !ids.has(t.id)) }, returning)
      if (receipt && result.issues.length) throw new Error(`配套布局未应用：${result.issues.join('；')}`)
      const next = mergeFloatingWorkspace(before, result.workspace)
      previousLayout.current = returning ? undefined : result.point
      update(() => receipt ? { ...next, presetApplication: receipt } : next)
      releasePages(before.tabs.filter(t => !next.tabs.some(n => n.id === t.id)).map(t => t.id))
      if (result.issues.length) notify(`部分预设内容未应用：${result.issues.join('；')}`)
      return true
    }
    return {
      capture: (page = tabTypeOf) => {
        const current = read()
        if (!current) throw new Error('工作区尚未就绪')
        return captureWorkbenchArrangement(mainWorkspace(current), { ...environment, page })
      },
      apply,
      preview: (layout: WorkbenchLayout, page = tabTypeOf) => previewWorkbenchArrangement(layout, { ...environment, page }),
      inspect: (layout: WorkbenchLayout, page = tabTypeOf) => inspectWorkbenchArrangement(layout, { ...environment, page }),
      canReturn: () => !!previousLayout.current,
      back: () => previousLayout.current ? apply(previousLayout.current.layout, previousLayout.current) : false
    }
  }, [read, catalog, transitions, update, notify, releasePages])
  const layoutRef = useRef(layoutActions)
  layoutRef.current = layoutActions
  const [presetController] = useState(() => createWorkbenchPresetService(new LayoutPresetStore(localStorage, libraryId), {
    preview: layout => layoutRef.current.preview(layout),
    inspect: layout => layoutRef.current.inspect(layout),
    capture: () => read() ? layoutRef.current.capture() : undefined,
    apply: layout => layoutRef.current.apply(layout), back: () => layoutRef.current.back(), canReturn: () => layoutRef.current.canReturn()
  }, workbenchPresetCatalog(), catalog.views.map(v => ({ id: v.id, title: v.title }))))
  const applying = useRef(false)
  const control = useCallback(async (input: Exclude<WorkbenchRequest, { action: 'session' }>, authorize: () => Promise<void>) => {
    if (!read()) throw new Error('[WORKBENCH_NOT_READY] 工作台尚未就绪')
    const ids = [...new Set(Object.values(input.layout?.contents ?? {}).flatMap(slot => slot.items.flatMap(item => item.kind === 'page' && item.type === 'collection' && typeof item.target.viewId === 'string' ? [item.target.viewId] : [])))]
    const page = localWorkbenchPages(ids.length ? await core.get(ids) : [])
    const current = layoutRef.current.capture(page), revision = await workbenchRevision(current)
    if (input.action === 'preview') {
      const snapshot = presetController.api.getSnapshot()
      return { current, revision, tools: snapshot.views, presets: snapshot.presets.map(({ id, title, layout }) => ({ id, title, layout })),
        ...(input.layout ? { preview: layoutRef.current.preview(input.layout, page) } : {}) }
    }
    if (applying.current) throw new Error('[WORKBENCH_BUSY] 工作台仍在保存')
    applying.current = true
    try {
      if (await window.bridge.pluginPresets.pending()) throw new Error('还有未完成的方案布局，请先接续或取消')
      await authorize()
      if (read()?.presetApplication !== input.requestId) {
        if (input.revision !== revision || JSON.stringify(current) !== JSON.stringify(layoutRef.current.capture(page))) throw new Error('[PREVIEW_CHANGED] 工作台已改变，请重新预演并使用新请求')
        const issues = layoutRef.current.inspect(input.layout, page)
        if (issues.length) throw new Error(issues.join('；'))
        if (!layoutRef.current.apply(input.layout, undefined, input.requestId, page)) throw new Error('[WORKBENCH_BUSY] 工作台尚未就绪或正在处理页面')
      }
      await checkpoint()
      return { saved: true }
    } finally { applying.current = false }
  }, [read, checkpoint, presetController, core])
  useLayoutEffect(() => presetController.refresh(), [presetController, ws?.tabs, ws?.editors, ws?.active, ws?.panels, ws?.sidebars, ws?.panelSizes])
  useEffect(() => {
    const changed = (e: StorageEvent) => { if (e.storageArea === localStorage && (!e.key || e.key === `rm:workbench-presets:${libraryId}`)) presetController.refresh() }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [presetController, libraryId])
  useEffect(() => {
    let alive = true, sequence = 0
    const load = async () => {
      const seq = ++sequence
      try {
        const schemes = await window.bridge.pluginPresets.list()
        if (alive && seq === sequence) presetController.setProvided([...workbenchPresetCatalog(), ...schemes.flatMap(p => p.layout ? [{ id: `scheme:${p.id}`, title: p.title, description: p.description, layout: p.layout, source: { kind: 'scheme' as const, id: p.id, title: p.source?.kind === 'suite' ? p.source.title : '用户组合' } }] : [])])
      } catch (e) { if (alive) notify(`方案布局目录读取失败：${String(e)}`) }
    }
    void load(); const off = window.bridge.pluginPresets.onChanged(() => void load())
    return () => { alive = false; off() }
  }, [presetController, notify])
  useLayoutEffect(() => {
    if (!ws) return
    let alive = true, running = false, requested = false
    const resume = async () => {
      requested = true
      if (running) return
      running = true
      try {
        while (alive && requested) {
          requested = false
          try {
            const title = await resumePresetArrangement(window.bridge.pluginPresets, {
              alive: () => alive,
              receipt: () => read()?.presetApplication,
              inspect: layout => layoutRef.current.inspect(layout),
              apply: (layout, id) => layoutRef.current.apply(layout, undefined, id),
              checkpoint
            })
            if (alive && title) notify(`已应用「${title}」的工作台安排`)
          } catch (e) { if (alive) notify(`方案尚未完成：${String(e)}`) }
        }
      } finally { running = false }
    }
    const off = window.bridge.pluginPresets.onChanged(() => void resume())
    void resume()
    return () => { alive = false; off() }
  }, [!!ws, read, checkpoint, notify])
  return { api: presetController.api, control }
}
