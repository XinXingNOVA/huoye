import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileEditingTask } from '@resource-manager/plugin-api/ui/file-editing'
import type { UiHost } from '@resource-manager/plugin-api/ui/contracts'

const empty = { tasks: [] as FileEditingTask[], unavailable: [] as FileEditingTask[], error: '', ready: false, refresh: async () => {} }
const EditingContext = createContext(empty)
/** 每个仓库窗口只有一个本机状态投影；卡片与多个视图订阅它，不逐卡读取 IPC 或散列文件。 */
export function FileEditingProvider({ host, children }: { host: UiHost; children: ReactNode }) {
  const [state, setState] = useState(empty)
  const generation = useRef(0), hasTasks = useRef(false)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const tasks = await host.fileEditing.list()
      const views = await host.core.get([...new Set(tasks.map(t => t.itemId))])
      const live = new Set(views.filter(v => !v.deletedAt && v.blocks.file).map(v => v.id))
      if (request === generation.current) {
        hasTasks.current = tasks.length > 0
        const next = { tasks, unavailable: tasks.filter(t => !live.has(t.itemId)), error: '', ready: true, refresh }
        setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      }
    } catch (e) { if (request === generation.current) setState(s => ({ ...s, error: String(e), ready: true })) }
  }, [host.core, host.fileEditing])
  useEffect(() => {
    setState(empty); void refresh()
    const changed = host.fileEditing.onChanged(() => void refresh())
    let timer: ReturnType<typeof setTimeout>
    const off = host.core.on('listChanged', () => { if (!hasTasks.current) return; clearTimeout(timer); timer = setTimeout(() => void refresh(), 150) })
    const focus = () => void refresh(); window.addEventListener('focus', focus)
    return () => { generation.current++; changed(); off(); clearTimeout(timer); window.removeEventListener('focus', focus) }
  }, [host.core, host.fileEditing, refresh])
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh])
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>
}
export const useFileEditing = () => useContext(EditingContext)
export const editingLabel = (task: FileEditingTask) => task.phase === 'cleanup' ? task.cleanupReason === 'discarded' ? '已放弃 · 待清理' : '已保存 · 待清理'
  : task.ended ? '旧工作副本待处理' : ({ editing: '编辑中', preparing: '保存待重试', ready: '编辑中 · 已检查', saving: '保存待核对', pending: '已保存 · 待本库接纳', unadopted: '已保存 · 本库未接纳' })[task.phase]
