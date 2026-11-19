// 一个具体的应用流程：先处置原件，再将本库素材移到回收站。不是跨数据库事务。
// 原子保存意图、复用两层回执，崩溃后只读核对；新的继续操作必须再次预览和确认。
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { FileSpace } from '../storage/file-space'
import { SpaceDisposal, type DisposalPlatform } from '../storage/space-disposal'
import { disposalInputSchema, type DisposalInput, type DisposalSelection } from '../shared/space-disposal'
import { itemLifecycleSchema, type ItemLifecycleInput, type ItemLifecycleResult } from '../shared/item-lifecycle'
import { disposalIds, disposalTaskId, itemDisposalExecution, itemDisposalSelection, type ItemDisposalExecution,
  type ItemDisposalPreview, type ItemDisposalSelection, type ItemDisposalSnapshot, type ItemDisposalTask } from '../shared/item-disposal'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const journalSchema = z.object({
  format: z.literal(1), libraryId: z.string(), id: disposalTaskId, ids: disposalIds, identityToken: z.string(), updatedAt: z.number(),
  targets: z.array(z.object({ spaceId: z.string().uuid(), fileId: z.string().uuid() })),
  library: z.enum(['pending', 'done']), message: z.string().optional(),
  files: z.array(z.object({ spaceId: z.string().uuid(), id: z.string().uuid(), name: z.string(), outcome: z.enum(['done', 'failed']), message: z.string() })),
  attempts: z.array(z.object({ requestId: disposalTaskId, signature: z.string(), spaces: z.array(disposalInputSchema), library: itemLifecycleSchema.optional() }))
})
type Journal = z.infer<typeof journalSchema>
export interface ItemDisposalPorts {
  snapshot(ids: string[]): Promise<ItemDisposalSnapshot>
  bindings(): Promise<{ id: string; root: string; state: string }[]>
  receipt(input: ItemLifecycleInput): Promise<ItemLifecycleResult | undefined>
  trash(input: ItemLifecycleInput): Promise<ItemLifecycleResult>
  changed(spaceId: string, fileIds?: string[]): Promise<void>
}
type Step = { spaceId: string; selection: DisposalSelection; token: string; resume?: DisposalInput }

export class ItemDisposal {
  private busy = false
  constructor(private root: string, private libraryId: string, private ports: ItemDisposalPorts, private platform: DisposalPlatform) {}
  private directory(create = false) {
    let path = realpathSync(this.root)
    for (const part of ['.app-operations', 'item-disposals']) {
      const parent = path
      path = join(path, part)
      if (!existsSync(path)) {
        if (!create) continue
        mkdirSync(path)
        if (process.platform !== 'win32') { const fd = openSync(parent, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
      }
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('[UNSAFE_PATH] 处理记录目录无效')
    }
    return path
  }
  private read(id: string): Journal {
    const path = join(this.directory(), disposalTaskId.parse(id) + '.json')
    if (lstatSync(path).isSymbolicLink()) throw new Error('[UNSAFE_PATH] 处理记录不能是符号链接')
    const task = journalSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (task.libraryId !== this.libraryId || task.id !== id) throw new Error('[TASK_IDENTITY] 处理记录与仓库不匹配')
    for (const attempt of task.attempts) {
      if (attempt.library && (attempt.library.action !== 'trash' || digest(attempt.library.ids) !== digest(task.ids))) throw new Error('[TASK_IDENTITY] 仓库步骤不匹配')
      for (const input of attempt.spaces) if (input.action !== 'trash' || input.files.some(f => !task.targets.some(t => t.spaceId === input.spaceId && t.fileId === f.id))) throw new Error('[TASK_IDENTITY] 文件步骤不匹配')
    }
    return task
  }
  private save(task: Journal) {
    task.updatedAt = Date.now()
    const dir = this.directory(true), path = join(dir, task.id + '.json'), temp = path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(task)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    if (process.platform !== 'win32') { const fd = openSync(dir, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  }
  private journals() {
    const dir = this.directory()
    return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(n => this.read(n.slice(0, -5))) : []
  }
  private async withSpace<T>(id: string, fn: (service: SpaceDisposal, space: FileSpace) => T | Promise<T>): Promise<T> {
    // 每次从本库有效关联解析位置，既不接受渲染器的路径，也不信任日志里过期的位置。
    const binding = (await this.ports.bindings()).find(b => b.id === id && b.state === 'active')
    if (!binding) throw new Error('[SPACE_UNLINKED] 原件所在空间已解除关联，请先重新关联')
    const space = new FileSpace(realpathSync(binding.root))
    try {
      if (space.id !== id) throw new Error('[FILE_SPACE_IDENTITY] 文件空间身份不匹配')
      return await fn(new SpaceDisposal(space, this.platform), space)
    } finally { space.close() }
  }
  private merge(task: Journal, spaceId: string, items: ItemDisposalTask['files']) {
    for (const item of items) {
      const index = task.files.findIndex(f => f.spaceId === spaceId && f.id === item.id)
      if (index < 0) task.files.push(item)
      else task.files[index] = item
    }
  }
  private async reconcile(task: Journal) {
    if (task.library === 'done') return
    for (const attempt of task.attempts) {
      if (attempt.library && await this.ports.receipt(attempt.library)) { task.library = 'done'; task.message = undefined; return }
    }
    for (const attempt of task.attempts) for (const input of attempt.spaces) {
      const receipt = await this.withSpace(input.spaceId, s => s.receipt(input))
      if (receipt) this.merge(task, input.spaceId, receipt.items.map(f => ({ ...f, spaceId: input.spaceId })))
    }
  }
  private summary(task: Journal): ItemDisposalTask {
    return { id: task.id, updatedAt: task.updatedAt, selected: task.ids.length, originals: task.targets.length,
      completed: task.files.filter(f => f.outcome === 'done').length, state: task.library === 'done' ? 'complete' : 'pending',
      library: task.library, running: this.busy, files: task.files, message: task.message }
  }
  async list(): Promise<ItemDisposalTask[]> {
    const tasks = this.journals().sort((a, b) => b.updatedAt - a.updatedAt)
    const result: ItemDisposalTask[] = []
    for (const task of tasks) {
      try { await this.reconcile(task) } catch (e) { task.message = errorText(e) }
      result.push(this.summary(task))
    }
    return result
  }
  private async plan(raw: ItemDisposalSelection) {
    const selection = itemDisposalSelection.parse(raw)
    const task = 'taskId' in selection ? this.read(selection.taskId) : undefined
    if (task) { await this.reconcile(task); if (task.library === 'done') throw new Error('[TASK_COMPLETE] 此操作已完成；撤销后的素材不会被旧任务再次删除') }
    const snapshot = await this.ports.snapshot(task?.ids ?? ('ids' in selection ? selection.ids : []))
    if (task && task.identityToken !== snapshot.identityToken) throw new Error('[TARGET_CHANGED] 素材的原件或附属关系已变化，旧任务不会扩大范围；请重新选择素材')
    const steps: Step[] = [], spaces: ItemDisposalPreview['spaces'] = [], blocked: string[] = []
    let completed = 0
    for (const info of snapshot.spaces) await this.withSpace(info.id, (service, space) => {
      const targets = snapshot.files.filter(f => f.spaceId === info.id), covered = new Set<string>()
      for (const f of targets) if (task?.files.some(r => r.spaceId === info.id && r.id === f.fileId && r.outcome === 'done')) {
        covered.add(f.fileId); completed++
        if (!service.confirmedDisposed(f.fileId)) blocked.push(`${info.name}：已处置的文件有恢复或状态变化，请到空间记录管理核对；旧任务不会再次移走它`)
      }
      const display: ItemDisposalPreview['spaces'][number] = { id: info.id, name: info.name, mode: info.mode, members: info.members, otherReferences: info.otherReferences, files: [] }
      const seen = new Set<string>()
      for (const attempt of task?.attempts ?? []) for (const input of attempt.spaces) {
        if (input.spaceId !== info.id || seen.has(input.requestId)) continue
        seen.add(input.requestId)
        const receipt = service.receipt(input)
        if (!receipt || receipt.finished) continue
        const preview = service.continuationPreview(input)
        steps.push({ spaceId: info.id, selection: { spaceId: info.id, action: 'trash', files: input.files }, token: preview.previewToken, resume: input })
        input.files.forEach(f => covered.add(f.id)); display.files.push(...preview.files)
      }
      const files = targets.filter(f => !covered.has(f.fileId)).map(f => {
        const file = space.byId(f.fileId)
        if (!file) throw new Error('[NOT_FOUND] 原件身份不存在')
        return { id: file.id, revision: file.revision }
      })
      if (files.length) {
        const input: DisposalSelection = { spaceId: info.id, action: 'trash', files }, preview = service.preview(input)
        steps.push({ spaceId: info.id, selection: input, token: preview.previewToken }); display.files.push(...preview.files)
      }
      blocked.push(...display.files.filter(f => f.reason).map(f => `${f.name}：${f.reason}`)); spaces.push(display)
    })
    const preview: ItemDisposalPreview = { previewToken: '', selected: snapshot.ids.length, affected: snapshot.affected.length, completed, blocked, spaces }
    preview.previewToken = digest([this.libraryId, task?.id, task?.attempts.length, snapshot.identityToken, snapshot.lifecycle.previewToken, preview, steps])
    return { task, snapshot, steps, preview }
  }
  async preview(selection: ItemDisposalSelection) {
    if (this.busy) throw new Error('[DISPOSAL_BUSY] 当前仓库的组合删除仍在进行')
    return (await this.plan(selection)).preview
  }
  async execute(raw: ItemDisposalExecution): Promise<ItemDisposalTask> {
    const input = itemDisposalExecution.parse(raw), signature = digest(input)
    if (this.busy) throw new Error('[DISPOSAL_BUSY] 当前仓库的组合删除仍在进行')
    this.busy = true
    try {
      for (const task of this.journals()) {
        const old = task.attempts.find(a => a.requestId === input.requestId)
        if (!old) continue
        if (old.signature !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求 ID 已用于其他组合删除')
        await this.reconcile(task)
        return { ...this.summary(task), running: false, replayed: true }
      }
      const plan = await this.plan(input.selection)
      if (plan.preview.previewToken !== input.previewToken) throw new Error('[PREVIEW_CHANGED] 素材、文件或空间已变化，请重新预览')
      if (plan.preview.blocked.length) throw new Error(plan.preview.blocked.join('\n'))
      const task: Journal = plan.task ?? { format: 1, libraryId: this.libraryId, id: input.requestId, ids: plan.snapshot.ids,
        identityToken: plan.snapshot.identityToken, targets: plan.snapshot.files, updatedAt: Date.now(), library: 'pending', files: [], attempts: [] }
      const attempt: Journal['attempts'][number] = { requestId: input.requestId, signature, spaces: [] }
      task.attempts.push(attempt); task.message = undefined; this.save(task)
      try {
        const checkLibrary = async () => {
          const now = await this.ports.snapshot(task.ids)
          if (now.identityToken !== plan.snapshot.identityToken || now.lifecycle.previewToken !== plan.snapshot.lifecycle.previewToken) throw new Error('[PREVIEW_CHANGED] 仓库内容已变化，请重新预览剩余步骤')
        }
        for (const [index, step] of plan.steps.entries()) {
          // 仓库内容若在异步文件处置期间变动，停止剩余步骤，保留已完成结果。
          await checkLibrary()
          const command = step.resume ?? { ...step.selection, previewToken: step.token, requestId: 'item-files-' + digest([task.id, input.requestId, index]) }
          attempt.spaces.push(command); this.save(task)
          const result = await this.withSpace(step.spaceId, service => service.execute(command))
          this.merge(task, step.spaceId, result.items.map(f => ({ ...f, spaceId: step.spaceId }))); this.save(task)
          if (result.items.some(f => f.outcome === 'failed')) throw new Error('部分原件未完成；本库素材尚未移入回收站')
        }
        for (const target of task.targets) {
          if (!await this.withSpace(target.spaceId, s => s.confirmedDisposed(target.fileId))) throw new Error('[DISPOSAL_CHANGED] 原件处置状态待核对，本库素材暂时保留')
        }
        await checkLibrary()
        attempt.library = { action: 'trash', ids: task.ids, previewToken: plan.snapshot.lifecycle.previewToken,
          requestId: 'item-records-' + digest([task.id, input.requestId]) }
        this.save(task)
        await this.ports.trash(attempt.library)
        task.library = 'done'; task.message = undefined; this.save(task)
      } catch (e) { task.message = errorText(e); this.save(task) }
      // 通知失败不能把已经提交的处置说成失败，也不能自动重发写入。
      for (const step of attempt.spaces) {
        try { await this.ports.changed(step.spaceId, step.files.map(f => f.id)) } catch (e) { console.warn('[item-disposal] 处置已记录，窗口刷新未完成', e) }
      }
      return { ...this.summary(task), running: false }
    } finally { this.busy = false }
  }
}
