import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { cleanupTargetSchema, defaultTaskLimits, taskLimitsSchema, type TaskCapacity, type TaskCleanupPlan, type TaskCleanupTarget, type TaskLimits, type TaskMarkerUsage, type TaskState } from '../shared/library-task'

// 所有外部写入口共用 operation_receipt。保留请求占位，避免旧请求号再次生效。
export const retiredSignature = 'retired-task'
export function checkRetiredRequest(signature: string) {
  if (signature === retiredSignature) throw new Error('[TASK_CLEANED] 任务明细已清理，此请求不能再次执行')
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const draftSheets = `SELECT s.id FROM main.task_write w JOIN main.review_sheet s ON s.id=w.sheet
  WHERE w.task=? AND s.state='draft'`
const preparations = `SELECT DISTINCT p.key,json_extract(p.data,'$.policy.spaceId') space
  FROM main.task_attempt a JOIN main.ingest_pending p ON p.key='mcp:'||a.request AND p.signature=a.signature WHERE a.task=?`

export class TaskRetention {
  private cachedMarkerUsage?: TaskMarkerUsage
  constructor(private db: Database.Database, private finishPreparation: (space: string, key: string) => void) {}

  private limits(): TaskLimits {
    const raw = this.db.prepare("SELECT value FROM main.config WHERE key='library-tasks.limits'").pluck().get() as string | undefined
    return raw ? taskLimitsSchema.parse(JSON.parse(raw)) : defaultTaskLimits
  }

  capacity(input?: TaskLimits): TaskCapacity {
    if (input !== undefined) {
      const limits = taskLimitsSchema.parse(input)
      this.db.prepare("INSERT OR REPLACE INTO main.config(key,value) VALUES('library-tasks.limits',?)").run(JSON.stringify(limits))
    }
    return { limits: this.limits(), tasks: this.count('SELECT count(*) FROM main.library_task'),
      drafts: this.count("SELECT count(*) FROM main.review_sheet WHERE state='draft'") }
  }

  private count(sql: string, ...args: string[]) {
    return Number(this.db.prepare(sql).pluck().get(...args))
  }

  markerUsage(): TaskMarkerUsage {
    if (!this.cachedMarkerUsage) {
      const tasks = this.count('SELECT count(*) FROM main.retired_task')
      const { requests, keyBytes } = this.db.prepare(`SELECT count(*) AS requests,
        coalesce(sum(length(CAST(request_id AS BLOB))), 0) AS keyBytes
        FROM main.operation_receipt WHERE signature=?`).get(retiredSignature) as { requests: number; keyBytes: number }
      // 按 4 KiB 页实测估算：任务摘要约 79 B；请求号另计约 18 B 行开销，页利用率约 85%。
      const estimatedBytes = tasks * 79 + Math.round((keyBytes + requests * 18) / 0.85)
      this.cachedMarkerUsage = { tasks, requests, estimatedBytes }
    }
    return this.cachedMarkerUsage
  }

  assertNewTask(id: string) {
    if (this.wasCleaned(id)) throw new Error('[TASK_CLEANED] 此任务标识已清理，请为新任务使用新的标识')
    if (this.count('SELECT count(*) FROM main.library_task') >= this.limits().tasks)
      throw new Error('[TASK_LIMIT] 仓库任务数已达上限，请在数据维护中清理已结束任务或调整上限')
  }

  wasCleaned(id: string) {
    return !!this.db.prepare('SELECT 1 FROM main.retired_task WHERE hash=?').get(digest(id))
  }

  assertAttemptRoom(task: string, adding: number) {
    const used = this.count('SELECT count(*) FROM main.task_attempt WHERE task=?', task)
    const max = this.limits().attempts
    if (used + adding > max)
      throw new Error(`[TASK_LIMIT] 本任务已记录 ${used} / ${max} 条尝试，本批需要 ${adding} 条。请减少本批输入、结束任务或调整上限`)
  }

  assertWriteRoom(task: string) {
    const limits = this.limits()
    if (this.count('SELECT count(*) FROM main.task_write WHERE task=?', task) >= limits.writes)
      throw new Error('[TASK_LIMIT] 单任务业务写入数已达上限，请结束任务或调整上限')
    if (this.count("SELECT count(*) FROM main.review_sheet WHERE state='draft'") >= limits.drafts)
      throw new Error('[TASK_LIMIT] 本库草稿数已达上限，请先送审或在数据维护中丢弃草稿')
  }

  preview(raw: TaskCleanupTarget): TaskCleanupPlan {
    return this.inspect(raw).plan
  }

  private inspect(raw: TaskCleanupTarget) {
    const target = cleanupTargetSchema.parse(raw)
    const { taskId, mode, requestId } = target
    const state = this.db.prepare('SELECT state FROM main.library_task WHERE id=?').pluck().get(taskId) as TaskState | undefined
    if (!state) throw new Error('[TASK_NOT_FOUND] 请刷新任务清单')
    if (mode === 'records' && state === 'active') throw new Error('[TASK_ACTIVE] 请先完成或放弃任务，再清理整项记录')
    const selected = requestId ? draftSheets + ' AND w.request=?' : draftSheets
    const args = requestId ? [taskId, requestId] : [taskId]
    const sheets = this.db.prepare(selected + ' ORDER BY s.id').pluck().all(...args) as string[]
    if (requestId && !sheets.length) throw new Error('[REVIEW_UNAVAILABLE] 此草稿已送审或已清理')
    const attempts = this.db.prepare('SELECT count(*) attempts,count(error) errors FROM main.task_attempt WHERE task=?').get(taskId) as {attempts:number;errors:number}
    const counts = {
      inputs: this.count('SELECT count(*) FROM main.task_input WHERE task=?', taskId), ...attempts,
      writes: this.count('SELECT count(*) FROM main.task_write WHERE task=?', taskId), drafts: sheets.length,
      changes: this.count(`SELECT count(*) FROM main.review_delta WHERE position>=0 AND batch IN (${selected})`, ...args),
      reviews: this.count(`SELECT count(DISTINCT s.id) FROM main.task_write w JOIN main.review_sheet s ON s.id=w.sheet
        WHERE w.task=? AND s.state<>'draft'`, taskId),
      preparations: this.count(`SELECT count(*) FROM (${preparations})`, taskId)
    }
    const revision = digest(JSON.stringify([taskId, mode, requestId, state, counts, sheets]))
    return { plan: { ...target, state, ...counts, revision }, sheets }
  }

  clean(raw: TaskCleanupTarget, revision: string): TaskCleanupPlan {
    return this.db.transaction(() => {
      const { plan, sheets } = this.inspect(raw)
      if (revision !== plan.revision) throw new Error('[PREVIEW_CHANGED] 清理范围已变化，请重新预览')
      const { taskId, mode } = plan
      if (mode === 'records') {
        // 先释放文件空间的复制批次。离线时保留仓库侧准备记录，重新连接后可重试。
        const pending = this.db.prepare(preparations).all(taskId) as { key: string; space: string | null }[]
        for (const { space, key } of pending) {
          if (space) this.finishPreparation(space, key)
          this.db.prepare('DELETE FROM main.ingest_pending WHERE key=?').run(key)
        }
      }
      const selected = JSON.stringify(sheets)
      this.db.prepare("UPDATE main.task_write SET sheet='' WHERE task=? AND sheet IN (SELECT value FROM json_each(?))").run(taskId, selected)
      this.db.prepare("DELETE FROM main.review_sheet WHERE state='draft' AND id IN (SELECT value FROM json_each(?))").run(selected)
      if (mode === 'records') {
        // 已成功的回执可能含原路径和错误；失败请求也占用原请求号，避免迟到重放。
        this.db.prepare(`INSERT INTO main.operation_receipt(request_id,signature,result,at)
          SELECT request,?,'',0 FROM (SELECT request FROM main.task_attempt WHERE task=? UNION SELECT request FROM main.task_write WHERE task=?) WHERE true
          ON CONFLICT(request_id) DO UPDATE SET signature=excluded.signature,result='',at=0
          WHERE EXISTS (SELECT 1 FROM main.task_write WHERE task=? AND request=excluded.request_id)
            OR EXISTS (SELECT 1 FROM main.task_attempt WHERE task=? AND request=excluded.request_id AND signature=operation_receipt.signature)`)
          .run(retiredSignature, taskId, taskId, taskId, taskId)
        this.db.prepare('INSERT INTO main.retired_task VALUES (?)').run(digest(taskId))
        this.db.prepare('DELETE FROM main.task_attempt WHERE task=?').run(taskId)
        this.db.prepare('DELETE FROM main.task_input WHERE task=?').run(taskId)
        this.db.prepare('DELETE FROM main.task_write WHERE task=?').run(taskId)
        this.db.prepare('DELETE FROM main.library_task WHERE id=?').run(taskId)
        this.cachedMarkerUsage = undefined
      }
      return plan
    }).immediate()
  }
}
