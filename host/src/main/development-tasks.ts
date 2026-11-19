import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonical } from '../shared/external-plugins'

const taskSchema = z.object({ requestId: z.string(), root: z.string(), libraryId: z.string(), signature: z.string(),
  action: z.enum(['apply_development_build', 'control_library']), state: z.enum(['pending', 'completed', 'failed']),
  saved: z.boolean(), error: z.string().optional(), finishedAt: z.string().optional() }).strict()
type Task = z.infer<typeof taskSchema>
/** 短操作回执，不自动重放生命周期动作；进程中断后的 pending 明确标为 interrupted。 */
export class DevelopmentTasks {
  private running = new Map<string, Promise<void>>()
  private roots = new Set<string>()
  constructor(private directory: string, private track: (task: Promise<void>) => void = () => {}) {}
  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('[INVALID_INPUT] 请求身份无效')
    return join(this.directory, `${id}.json`)
  }
  private save(task: Task) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = this.file(task.requestId)
    writeFileSync(file + '.tmp', JSON.stringify(task), { mode: 0o600 }); renameSync(file + '.tmp', file)
  }
  read(requestId: string, libraryId: string, root: string) {
    if (!existsSync(this.file(requestId))) throw new Error('[REQUEST_NOT_FOUND] 没有此开发验收回执')
    const task = taskSchema.parse(JSON.parse(readFileSync(this.file(requestId), 'utf8')))
    if (task.libraryId !== libraryId || task.root !== root) throw new Error('[ACCESS_DENIED] 请求不属于此仓库')
    return { ...task, root: undefined, signature: undefined, running: this.running.has(requestId),
      state: task.state === 'pending' && !this.running.has(requestId) ? 'interrupted' as const : task.state }
  }
  submit<T extends { requestId: string; libraryId: string }>(action: Task['action'], input: T, root: string, run: (saved: () => void) => Promise<void>) {
    const signature = createHash('sha256').update(canonical({ action, input, root })).digest('hex')
    if (existsSync(this.file(input.requestId))) {
      const old = taskSchema.parse(JSON.parse(readFileSync(this.file(input.requestId), 'utf8')))
      if (old.signature !== signature) throw new Error('[REQUEST_CONFLICT] 请求身份已用于其他参数')
      return this.read(input.requestId, input.libraryId, root)
    }
    if (this.roots.has(root)) throw new Error('[LIBRARY_BUSY] 此仓库仍在执行开发验收操作')
    const task: Task = { action, requestId: input.requestId, libraryId: input.libraryId, root, signature, state: 'pending', saved: false }
    this.save(task); this.roots.add(root)
    const done = Promise.resolve().then(async () => {
      try { await run(() => { task.saved = true; this.save(task) }); task.state = 'completed' }
      catch (error) { task.state = 'failed'; task.error = String(error).slice(0, 4000) }
      finally {
        task.finishedAt = new Date().toISOString()
        try { this.save(task) } finally { this.running.delete(task.requestId); this.roots.delete(root) }
      }
    })
    this.running.set(task.requestId, done)
    this.track(done)
    void done.catch(error => console.error('[development-task] 回执保存失败，保留 pending 供核对', error))
    return this.read(input.requestId, input.libraryId, root)
  }
}
