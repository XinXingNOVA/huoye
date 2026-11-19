import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { managementSchemas } from '../shared/application-management'
import type { WorkbenchRequest, WorkbenchPreview } from '../shared/workbench-control'
import { canonical } from '../shared/external-plugins'
import type { OpenLibrary } from './libraries'
import { loadWorkspace } from './workspace-storage'
import { trustedWindow } from './trusted-window'
import { isWindowReady } from './page-lifecycle'
import { matchesPresentationWindow, workbenchSessionWindows } from './auxiliary-windows'
import type { SessionRequest } from '../shared/workbench-session'

const pending = new Map<string, { lib: OpenLibrary; guard(): void; resolve(value: unknown): void; reject(error: Error): void }>()
export function registerWorkbenchControl() {
  ipcMain.handle('workbench:authorize', (event, id: string) => {
    trustedWindow(event)
    const task = pending.get(id)
    if (!task || task.lib.win.webContents !== event.sender) throw new Error('工作台请求已失效')
    task.guard()
  })
  ipcMain.on('workbench:result', (event, id: string, value: unknown, error?: string) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const task = pending.get(id)
    if (!task || task.lib.win.webContents !== event.sender) return
    if (error) task.reject(new Error(error)); else task.resolve(value)
  })
}
function callWorkbench(lib: OpenLibrary, input: WorkbenchRequest, guard: () => void, beforeApply?: () => void): Promise<unknown> {
  const check = () => {
    guard()
    if (lib.reloading || lib.offline || !isWindowReady(lib.win)) throw new Error('[WORKBENCH_NOT_READY] 请等待仓库工作台加载完成')
  }
  check()
  return new Promise((resolve, reject) => {
    const id = randomUUID(), wc = lib.win.webContents
    const finish = (value: unknown, error?: Error) => {
      clearTimeout(timer); pending.delete(id)
      wc.removeListener('destroyed', gone); wc.removeListener('render-process-gone', gone); wc.removeListener('did-navigate', gone)
      if (error) reject(error); else { try { check(); resolve(value) } catch (e) { reject(e) } }
    }
    const gone = () => finish(undefined, new Error('工作台已关闭或重载，请查询请求状态'))
    const timer = setTimeout(() => finish(undefined, new Error('工作台处理超时，请查询请求状态后重试')), 30000)
    pending.set(id, { lib, guard: () => { check(); beforeApply?.() }, resolve: value => finish(value), reject: error => finish(undefined, error) })
    wc.once('destroyed', gone); wc.once('render-process-gone', gone); wc.once('did-navigate', gone)
    wc.send('workbench:request', id, input)
  })
}
export async function workbenchSession(lib: OpenLibrary, request: SessionRequest, guard: () => void) {
  const windows = workbenchSessionWindows(lib.win)
  const checkWindow = () => {
    const current = request.action === 'present'
      ? matchesPresentationWindow(lib.win, request.input.expected.windowRevision)
      : workbenchSessionWindows(lib.win).revision === windows.revision
    if (!current) throw new Error('[CONTEXT_CHANGED] 仓库窗口状态已变化，请重新读取现场')
  }
  const result = await callWorkbench(lib, { action: 'session', request, windows }, guard, checkWindow)
  if (request.action === 'read') checkWindow()
  return result
}
const taskSchema = managementSchemas.configure_workbench.extend({ root: z.string(), signature: z.string(), receipt: z.string().uuid(), state: z.enum(['pending', 'completed']), error: z.string().optional() }).strict()
type Task = z.infer<typeof taskSchema>
/** 只记录 AI 意图与回执；布局和草稿仍由现有工作区控制器保存。不会在启动时自动重放。 */
export function createWorkbenchControl(directory: string) {
  const running = new Map<string, Promise<unknown>>()
  const file = (id: string) => join(directory, `${managementSchemas.get_workbench_configuration.parse({ libraryId: '_', requestId: id }).requestId}.json`)
  const read = (id: string) => taskSchema.parse(JSON.parse(readFileSync(file(id), 'utf8')))
  const save = (task: Task) => {
    mkdirSync(directory, { recursive: true })
    const data = JSON.stringify(task)
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('工作台配置请求过大')
    writeFileSync(file(task.requestId) + '.tmp', data, { mode: 0o600 }); renameSync(file(task.requestId) + '.tmp', file(task.requestId))
  }
  const status = async (task: Task, guard: () => void) => {
    const receipt = (await loadWorkspace(task.libraryId))?.presetApplication
    guard()
    if (task.state !== 'completed' && receipt === task.receipt) { task.state = 'completed'; task.error = undefined; save(task) }
    return { requestId: task.requestId, libraryId: task.libraryId, state: task.state, running: running.has(task.libraryId), error: task.error }
  }
  return {
    preview: (lib: OpenLibrary, layout: WorkbenchRequest & { action: 'preview' }, guard: () => void) => callWorkbench(lib, layout, guard) as Promise<WorkbenchPreview>,
    async get(lib: OpenLibrary, requestId: string, guard: () => void) {
      const task = read(requestId)
      if (task.libraryId !== lib.id || task.root !== lib.root) throw new Error('[ACCESS_DENIED] 请求不属于此仓库')
      return status(task, guard)
    },
    async configure(lib: OpenLibrary, input: z.infer<typeof managementSchemas.configure_workbench>, guard: () => void) {
      if (running.has(lib.id)) throw new Error('[WORKBENCH_BUSY] 工作台仍在处理上一请求，请稍后读取状态')
      const run = (async () => {
        const signature = createHash('sha256').update(canonical(input)).digest('hex')
        let task: Task
        if (existsSync(file(input.requestId))) {
          task = read(input.requestId)
          if (task.root !== lib.root || task.signature !== signature) throw new Error('[REQUEST_CONFLICT] 同一请求不能更换工作台配置')
          if ((await status(task, guard)).state === 'completed') return status(task, guard)
        } else { task = { ...input, root: lib.root, signature, receipt: randomUUID(), state: 'pending' }; guard(); save(task) }
        try {
          await callWorkbench(lib, { action: 'apply', layout: task.layout, revision: task.revision, requestId: task.receipt }, guard)
          guard()
          if ((await loadWorkspace(lib.id))?.presetApplication !== task.receipt) throw new Error('工作台尚未保存成功，请重试原请求')
          task.state = 'completed'; task.error = undefined; save(task)
        } catch (e) { task.error = String(e); save(task); guard() }
        return status(task, guard)
      })()
      running.set(lib.id, run)
      try { const result = await run; return { ...result, running: false } } finally { running.delete(lib.id) }
    }
  }
}
