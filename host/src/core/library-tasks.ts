import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { libraryTaskSchema, type LibraryTaskInput, type LibraryTaskResult, type TaskSummary, type TaskInputStatus, type TaskAttempt, type TaskWrite } from '../shared/library-task'
import type { TaskRetention } from './task-retention'
import type { BatchReviews } from './batch-review'
import type { ImportInput } from '../shared/ingest-input'
import type { ImportReport } from '../shared/import-settings'

export const libraryTaskSql = `
CREATE TABLE IF NOT EXISTS main.retired_task (hash TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS main.library_task (id TEXT PRIMARY KEY, title TEXT NOT NULL, signature TEXT NOT NULL, created INTEGER NOT NULL, input_count INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', ended INTEGER);
CREATE TABLE IF NOT EXISTS main.task_input (task TEXT NOT NULL, path TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(task,path), UNIQUE(task,position));
CREATE TABLE IF NOT EXISTS main.task_attempt (task TEXT NOT NULL, path TEXT NOT NULL, request TEXT NOT NULL, signature TEXT NOT NULL, attempt INTEGER NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL, entity TEXT, file TEXT, error TEXT, UNIQUE(request,attempt,position));
CREATE INDEX IF NOT EXISTS main.task_attempt_path ON task_attempt(task,path);
CREATE TABLE IF NOT EXISTS main.task_write (request TEXT PRIMARY KEY, task TEXT NOT NULL, operation TEXT NOT NULL, sheet TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS main.task_write_task ON task_write(task);
`
const summary = 'id AS taskId,title,created,input_count AS inputCount,state,ended AS endedAt'
const attempt = 'a.request AS requestId,a.entity AS entityId,a.file AS fileId,a.error'

export class LibraryTasks {
  constructor(private db: Database.Database, private reviews: BatchReviews, private retention: TaskRetention) {
    db.prepare("UPDATE main.task_attempt SET state='interrupted' WHERE state='running'").run()
  }
  require(id: string): TaskSummary {
    const task = this.db.prepare(`SELECT ${summary} FROM main.library_task WHERE id=?`).get(id) as TaskSummary | undefined
    if (!task && this.retention.wasCleaned(id)) throw new Error('[TASK_CLEANED] 此任务记录已清理')
    if (!task) throw new Error('[TASK_NOT_FOUND] 本库没有这项任务，请先列出或创建清单')
    return task
  }
  assertActive(id: string) {
    if (this.require(id).state !== 'active') throw new Error('[TASK_CLOSED] 此任务已结束，请使用新的任务标识')
  }

  private close(id: string, state: 'completed' | 'abandoned') {
    return this.db.transaction(() => {
      const task = this.require(id)
      if (task.state === state) return task
      this.assertActive(id)
      if (this.db.prepare("SELECT 1 FROM main.task_attempt WHERE task=? AND state='running' LIMIT 1").get(id))
        throw new Error('[TASK_BUSY] 有正在执行的导入，请等待结果再结束任务')
      if (state === 'completed') {
        const unfinished = this.db.prepare(`SELECT 1 FROM main.task_input i WHERE i.task=? AND coalesce((
          SELECT state FROM main.task_attempt WHERE task=i.task AND path=i.path ORDER BY rowid DESC LIMIT 1
        ),'unattempted') NOT IN ('created','existing','restored','stored') LIMIT 1`).get(id)
        if (unfinished) throw new Error('[TASK_INCOMPLETE] 有未处理、失败或中断的输入，请处理后完成，或放弃任务')
        if (this.db.prepare("SELECT 1 FROM main.task_write w JOIN main.review_sheet s ON s.id=w.sheet WHERE w.task=? AND s.state='draft' LIMIT 1").get(id))
          throw new Error('[TASK_DRAFTS] 有未送审的写入，请先送审或在数据维护中丢弃草稿')
      }
      this.db.prepare('UPDATE main.library_task SET state=?,ended=? WHERE id=?').run(state, Date.now(), id)
      return this.require(id)
    }).immediate()
  }

  run(raw: LibraryTaskInput): LibraryTaskResult {
    const input = libraryTaskSchema.parse(raw)
    if (input.action === 'create') {
      const { taskId, title, inputs } = input
      const signature = createHash('sha256').update(JSON.stringify([title, inputs])).digest('hex')
      this.db.transaction(() => {
        const saved = this.db.prepare('SELECT signature FROM main.library_task WHERE id=?').pluck().get(taskId)
        if (saved === signature) return
        if (saved) throw new Error('[TASK_CONFLICT] 该任务标识已绑定其他输入清单或标题')
        this.retention.assertNewTask(taskId)
        this.db.prepare('INSERT INTO main.library_task(id,title,signature,created,input_count) VALUES (?,?,?,?,?)').run(taskId, title, signature, Date.now(), inputs.length)
        const insert = this.db.prepare('INSERT INTO main.task_input VALUES (?,?,?)')
        inputs.forEach((path, i) => insert.run(taskId, path, i))
      })()
      return this.run({ action: 'get', taskId })
    }
    if (input.action === 'complete' || input.action === 'abandon')
      return { task: this.close(input.taskId, input.action === 'complete' ? 'completed' : 'abandoned'), nextOffset: null }
    const { offset, limit } = input
    const page = <T>(rows: T[]) => ({ rows: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null })
    if (input.action === 'list') {
      const p = page(this.db.prepare(`SELECT ${summary} FROM main.library_task ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?`).all(limit+1,offset) as TaskSummary[])
      return { tasks: p.rows, capacity: this.retention.capacity(), nextOffset: p.nextOffset }
    }
    const task = this.require(input.taskId), args = [input.taskId, limit + 1, offset]
    if (input.action === 'diff') {
      const { items, nextOffset } = this.reviews.draft(input.taskId, input.requestId, offset, limit)
      return { task, draft: { requestId: input.requestId, items }, nextOffset }
    }
    if (input.section === 'attempts') {
      const p = page(this.db.prepare(`SELECT a.path,a.state,a.attempt AS attemptNo,${attempt} FROM main.task_attempt a WHERE a.task=? ORDER BY a.rowid LIMIT ? OFFSET ?`).all(...args) as TaskAttempt[])
      return { task, attempts: p.rows, nextOffset: p.nextOffset }
    }
    if (input.section === 'writes') {
      const p = page(this.db.prepare(`SELECT w.request AS requestId,w.operation,CASE WHEN w.sheet='' THEN 'discarded' ELSE coalesce(s.state,'unavailable') END AS reviewState,
        CASE WHEN s.state<>'draft' THEN s.id END AS batchId FROM main.task_write w LEFT JOIN main.review_sheet s ON s.id=w.sheet
        WHERE w.task=? ORDER BY w.rowid LIMIT ? OFFSET ?`).all(...args) as TaskWrite[])
      return { task, writes: p.rows, nextOffset: p.nextOffset }
    }
    const p = page(this.db.prepare(`SELECT i.path,coalesce(a.state,'unattempted') AS state,${attempt} FROM main.task_input i
      LEFT JOIN main.task_attempt a ON a.rowid=(SELECT rowid FROM main.task_attempt WHERE task=i.task AND path=i.path ORDER BY rowid DESC LIMIT 1)
      WHERE i.task=? ORDER BY i.position LIMIT ? OFFSET ?`).all(...args) as TaskInputStatus[])
    return { task, inputs: p.rows, nextOffset: p.nextOffset }
  }

  checkRequest(request: string, signature: string) {
    const old = this.db.prepare('SELECT signature FROM main.task_attempt WHERE request=? LIMIT 1').pluck().get(request)
    if (old && old !== signature) throw new Error('[REQUEST_ID_CONFLICT] 请求已绑定另一项任务或参数')
  }
  begin(task: string, inputs: ImportInput[], request: string, signature: string) {
    this.db.transaction(() => {
      this.assertActive(task)
      this.retention.assertAttemptRoom(task, inputs.length)
      const nextAttempt = this.db.prepare('SELECT coalesce(max(attempt),0)+1 FROM main.task_attempt WHERE task=? AND path=?').pluck()
      const member = this.db.prepare('SELECT 1 FROM main.task_input WHERE task=? AND path=?')
      const insert = this.db.prepare("INSERT INTO main.task_attempt(task,path,request,signature,attempt,position,state) VALUES(?,?,?,?,?,?,'running')")
      inputs.forEach((input,i) => {
        if (input.type !== 'file' || !member.get(task,input.path)) throw new Error('[TASK_INPUT_UNKNOWN] 请从这项任务已登记的路径中选择文件')
        insert.run(task, input.path, request, signature, nextAttempt.get(task, input.path), i)
      })
    })()
  }
  finish(request: string, result: ImportReport) {
    const update = this.db.prepare("UPDATE main.task_attempt SET state=?,entity=?,file=?,error=? WHERE request=? AND position=? AND state='running'")
    const saved = new Map(result.saved.map(file => [file.index, file]))
    const items = new Map(result.items.map(item => [item.index, item]))
    const errors = new Map(result.errors.map(error => [error.index, error.message]))
    for (const index of new Set([...saved.keys(), ...items.keys(), ...errors.keys()])) {
      const file = saved.get(index), item = items.get(index), error = errors.get(index)
      update.run(error ? 'failed' : item?.outcome ?? 'stored', item?.id ?? null, file?.fileId ?? null, error?.slice(0, 2000) ?? null, request, index)
    }
  }
  fail(request: string, error: unknown) {
    this.db.prepare("UPDATE main.task_attempt SET state='failed',error=? WHERE request=? AND state='running'").run(String(error).slice(0, 2000), request)
  }
}
