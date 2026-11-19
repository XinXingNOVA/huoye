// 协议无关的对外操作服务。接入层先检查连接权限；此处只执行启用插件显式开放的命令。
import { createHash } from 'node:crypto'
import { executeOperationSchema, jsonSchema, parseInput, type ExecuteOperationRequest, type OperationDescription, type OperationResult } from '../shared/automation'
import type { CommandContext } from '../plugin-api/core/contracts'
import type { History } from './history'
import type { Library } from './library'
import type { Registry } from './registry'
import type { Store } from './store'
import type { Ingesting } from './ingest'
import { checkRetiredRequest, type TaskRetention } from './task-retention'
import type { LibraryTasks } from './library-tasks'
import type { BatchReviews } from './batch-review'
import { observeReviewCommand } from './review-command'
import { invokeCommand } from './commands'

export function describeOperations(reg: Registry): OperationDescription[] {
  return reg.plugins.flatMap(p => (p.operations ?? []).map(op => ({
    name: op.name, title: op.title, description: op.description, inputSchema: jsonSchema(op.input), effect: op.effect, ...(op.reviewable === false ? { reviewable: false as const } : {})
  })))
}

export class Operations {
  private pending = new Map<string, { signature: string; task: Promise<OperationResult> }>()
  constructor(private lib: Library, private reg: Registry, private store: Store,
    private history: History, private context: (plugin: string) => CommandContext, private ingest: Ingesting,
    private tasks: LibraryTasks, private reviews: BatchReviews, private retention: TaskRetention) {}

  execute(input: ExecuteOperationRequest): OperationResult | Promise<OperationResult> {
    const { operation, requestId, args, taskId } = parseInput(executeOperationSchema, input)
    const registered = this.reg.plugins.flatMap(plugin => (plugin.operations ?? []).map(op => ({ plugin, op })))
    const entry = registered.find(({ op }) => op.name === operation)
    if (!entry) throw new Error('[UNAVAILABLE_OPERATION] 这个操作未开放或所属插件已停用')
    const data = parseInput(entry.op.input, args)
    const signature = createHash('sha256').update(JSON.stringify(taskId ? [operation, data, taskId] : [operation, data])).digest('hex')
    const checkSignature = (old: string) => {
      if (old !== signature) throw new Error('[REQUEST_ID_CONFLICT] 同一 requestId 不能用于不同操作')
    }
    const old = this.lib.db.prepare('SELECT signature, result FROM main.operation_receipt WHERE request_id = ?').get(requestId) as { signature: string; result: string } | undefined
    if (old) { checkRetiredRequest(old.signature); checkSignature(old.signature); return { requestId, replayed: true, result: JSON.parse(old.result) } }
    const reviewable = entry.op.effect === 'data' && !!entry.op.command && entry.op.reviewable !== false
    if (taskId) {
      this.tasks.assertActive(taskId)
      if (!reviewable) throw new Error('[REVIEW_UNSUPPORTED] 只有数据编辑命令可生成验收草稿')
    }
    this.tasks.checkRequest(requestId, signature)
    const prepared = this.lib.db.prepare('SELECT signature FROM main.ingest_pending WHERE key = ?').get(`mcp:${requestId}`) as { signature: string } | undefined
    if (prepared) checkSignature(prepared.signature)
    const pending = this.pending.get(requestId)
    if (pending) { checkSignature(pending.signature); return pending.task.then(result => ({ ...result, replayed: true })) }
    const context = { source: 'external' as const, plugin: entry.plugin.id, operation, requestId, reviewable }
    const save = (result: unknown): OperationResult => {
      this.lib.db.prepare('INSERT INTO main.operation_receipt VALUES (?, ?, ?, ?)').run(requestId, signature, JSON.stringify(result), Date.now())
      return { requestId, replayed: false, result }
    }
    if (entry.op.ingest) {
      const task = this.ingest.run(entry.op.ingest(data), false, apply => this.store.batch(() =>
        save(this.history.run(r => `外部 · 收录 ${r.items.length} 项`, apply, context))), { key: `mcp:${requestId}`, signature })
        .finally(() => this.pending.delete(requestId))
      this.pending.set(requestId, { signature, task })
      return task
    }
    const command = entry.plugin.commands![entry.op.command]
    return this.store.batch(() => {
      if (taskId) this.retention.assertWriteRoom(taskId)
      const base = this.context(entry.plugin.id)
      const ctx = context.reviewable ? observeReviewCommand(base, context) : base
      const result = this.history.run(r => `外部 · ${r.label}`, () => invokeCommand(command, ctx, data), context)
      if (taskId) this.reviews.capture(taskId, requestId, operation, context.reviewable)
      return save(result.result ?? null)
    })
  }
}
