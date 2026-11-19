import { blurDisplayInputs } from '../display-windows'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TabLeaveContext } from '../../../plugin-api/ui/contracts'
import type { EditSessions } from '../editing-sessions'
import { otherPageViews } from '../page-instances'
import { PageTransitions } from '../page-transitions'
import { tabTypeOf } from '../ui-registry'
import type { TabEntry, Workspace } from '../workspace'
import type { PageHosts } from './page-access'

interface LifecycleOptions {
  libraryId: string
  snapshot: Workspace | undefined
  readWorkspace(): Workspace | undefined
  editing: EditSessions
  draftTick: number
  hosts: PageHosts
  beforePrepare?(reason: 'reload' | 'shutdown', signal: AbortSignal): Promise<void>
  notify(text: string): void
  reportSaveError(text: string): void
}

/** 保存与结束使用的顺序集中在这里；暂时卸载页面组件不触发 beforeLeave。 */
export function usePageLifecycle({ libraryId, snapshot: ws, readWorkspace, editing, draftTick, hosts, beforePrepare, notify: showToast, reportSaveError }: LifecycleOptions) {
  const [leaving, setLeaving] = useState(false)
  const [transitions] = useState(() => new PageTransitions(setLeaving))
  const leavePage = useCallback(async (entry: TabEntry, reason: TabLeaveContext['reason'], signal: AbortSignal, nextParams?: Record<string, unknown>) => {
    const rule = tabTypeOf(entry.type)
    await rule?.beforeLeave?.({ id: entry.id, params: entry.params, saved: entry.state, host: hosts.forPage(entry.id), reason, nextParams, signal, otherViews: otherPageViews(readWorkspace()?.tabs ?? [], entry, rule) })
  }, [hosts, readWorkspace])
  const workspaceSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!ws || workspaceSaveTimer.current) return
    // 合并当前时间片内的变化，连续滚动也会定期落盘，不无限推迟快照。
    workspaceSaveTimer.current = setTimeout(() => {
      workspaceSaveTimer.current = undefined
      const current = readWorkspace()
      if (current) void window.bridge.saveWorkspace(libraryId, { ...current, drafts: editing.export() }).catch(error => reportSaveError(`本机恢复状态保存失败：${String(error)}`))
    }, 400)
  }, [ws, libraryId, draftTick, editing, readWorkspace, reportSaveError])
  useEffect(() => () => clearTimeout(workspaceSaveTimer.current), [])

  const checkpoint = useCallback(async () => {
    clearTimeout(workspaceSaveTimer.current); workspaceSaveTimer.current = undefined
    const current = readWorkspace()
    if (current) await window.bridge.saveWorkspace(libraryId, { ...current, drafts: editing.export() })
  }, [libraryId, editing, readWorkspace])

  useEffect(() => {
    if (!ws) return
    const off = window.bridge.lifecycle.onPrepare(async (reason, recovery) => {
      await transitions.finish(async signal => {
        blurDisplayInputs()
        await checkpoint()
        // 后台已经退出时无法写仓库；保留快照后让主进程重新建立运行环境。
        if (recovery) return
        if (beforePrepare) await beforePrepare(reason, signal)
        for (const entry of readWorkspace()?.tabs ?? []) {
          signal.throwIfAborted()
          await leavePage(entry, reason, signal)
        }
        await editing.flush()
        await checkpoint()
      })
    }, () => transitions.resume())
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (transitions.prepared || !navigator.userActivation.hasBeenActive) return
      // 菜单／插件重载已在主进程准备；捕获 Chromium 自带的重载路径。
      event.preventDefault()
      event.returnValue = '正在保存页面状态'
      void window.bridge.lifecycle.reload()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { off(); window.removeEventListener('beforeunload', beforeUnload) }
  }, [!!ws, checkpoint, transitions, editing, readWorkspace, leavePage, beforePrepare])

  const changePage = useCallback((id: string, reason: TabLeaveContext['reason'], commit: () => void, nextParams?: Record<string, unknown>) => {
    if (transitions.busy) return Promise.resolve(false)
    const entry = readWorkspace()?.tabs.find(t => t.id === id)
    if (!entry) return Promise.resolve(false)
    if (!tabTypeOf(entry.type)?.beforeLeave) { commit(); return Promise.resolve(true) }
    blurDisplayInputs()
    return transitions.change(async signal => {
      await checkpoint()
      const latest = readWorkspace()?.tabs.find(t => t.id === id)
      if (latest) await leavePage(latest, reason, signal, nextParams)
    }, commit).catch(error => { showToast(`页面已保留：${String(error)}`); return false })
  }, [transitions, checkpoint, showToast, readWorkspace, leavePage])

  const changePages = useCallback((ids: string[], commit: () => void) => {
    if (transitions.busy) return Promise.resolve(false)
    blurDisplayInputs()
    return transitions.change(async signal => {
      await checkpoint()
      for (const id of ids) {
        signal.throwIfAborted()
        const entry = readWorkspace()?.tabs.find(t => t.id === id)
        if (entry) await leavePage(entry, 'close', signal)
      }
    }, commit).catch(error => { showToast(`窗口已保留：${String(error)}`); return false })
  }, [transitions, checkpoint, readWorkspace, leavePage, showToast])
  return { leaving, transitions, changePage, changePages, checkpoint }
}
