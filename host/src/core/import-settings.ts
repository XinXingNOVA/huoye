import { checkRetiredRequest } from './task-retention'
import type { LibraryTasks } from './library-tasks'
import type { HistorySource } from '../shared/history'
// 仓库的导入策略。文件空间只提供事实；本类决定本仓库何时接纳，不修改其他仓库。
import { readImportPolicy, type ImportPolicy } from './import-policy'
import { createHash, randomUUID } from 'node:crypto'
import type { Library } from './library'
import type { Store } from './store'
import type { FileSpace } from '../storage/file-space'
import type { History } from './history'
import type { Ingesting } from './ingest'
import type { LibrarySpaces } from './file-spaces'
import type { ImportInput } from '../shared/ingest-input'
import type { Admission } from './admission'
import { viewImportOptionsSchema, type ViewImportOptions } from '../shared/view-import'
import { importOptionsSchema, importSettingsSchema, type ImportOptions, type ImportReport, type ImportScan, type ImportSettings, type ImportSettingsInput } from '../shared/import-settings'

export class LibraryImports {
  private pending = new Map<string, { signature: string; task: Promise<ImportReport> }>()
  private readonly discoveredThrough = new WeakMap<FileSpace, number>()

  constructor(private lib: Library, private store: Store, private history: History, private ingest: Ingesting, private spaces: LibrarySpaces, private admission: Admission, private tasks: LibraryTasks) {}

  forgetSpacePolicy(spaceId: string): void {
    const policy = readImportPolicy(this.lib)
    if (!policy.spaces.some(rule => rule.spaceId === spaceId)) return
    this.lib.db.prepare("UPDATE main.config SET value=? WHERE key='imports.v1'").run(JSON.stringify({ ...policy, spaces: policy.spaces.filter(rule => rule.spaceId !== spaceId) }))
  }
  get(): ImportSettings {
    const policy = readImportPolicy(this.lib), bindings = this.spaces.list({ includeCounts: true }).map(binding => {
      if (binding.error) return binding
      const files = new Set(this.lib.files.bindings!.open(binding.id).db.prepare("SELECT id FROM files WHERE state='available' AND id NOT IN (SELECT file_id FROM recycled_files)").pluck().all() as string[])
      return { ...binding, uncollected: binding.counts?.uncollected,
        pending: (this.lib.db.prepare("SELECT file_id FROM main.space_import_seen WHERE space_id=? AND state='pending'").pluck().all(binding.id) as string[]).filter(id => files.has(id)).length }
    })
    return { ...policy, spaces: policy.spaces.filter(r => bindings.some(b => b.id === r.spaceId && b.state === 'active')), defaultSpaceId: bindings.find(b => b.default)!.id, bindings }
  }
  set(input: ImportSettingsInput): ImportSettings {
    const next = importSettingsSchema.parse(input), previous = readImportPolicy(this.lib)
    if (new Set(next.spaces.map(s => s.spaceId)).size !== next.spaces.length) throw new Error('同一空间不能重复配置')
    this.lib.db.transaction(() => {
      if (this.lib.files.bindings!.rows().find(r => r.is_default)?.id !== next.defaultSpaceId) this.lib.files.bindings!.setDefault(next.defaultSpaceId)
      for (const rule of next.spaces) {
        if (this.lib.files.bindings!.binding(rule.spaceId).state !== 'active') throw new Error('只能配置已关联的空间')
        if (!rule.automatic || previous.spaces.some(s => s.spaceId === rule.spaceId && s.automatic)) continue
        const space = this.lib.files.bindings!.open(rule.spaceId)
        // 显式启用时冻结存量；以后出现的新身份才参与自动收录，不靠时间戳猜测。
        space.exclusive(() => {
          const insert = this.lib.db.prepare("INSERT INTO main.space_import_seen VALUES (?,?,'seen',NULL) ON CONFLICT(space_id,file_id) DO UPDATE SET state='seen',error=NULL")
          for (const id of space.db.prepare('SELECT id FROM files').pluck().all() as string[]) insert.run(space.id, id)
        })
      }
      this.lib.db.prepare("INSERT INTO main.config VALUES ('imports.v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ collect: next.collect, spaces: next.spaces }))
    })()
    return this.get()
  }

  intoView(inputs: ImportInput[], raw: ViewImportOptions): Promise<ImportReport> {
    const view = viewImportOptionsSchema.parse(raw)
    if (view.allowUnmatched.some(index => index >= inputs.length)) throw new Error('收录选择超出本次输入范围')
    return this.run(inputs, { requestId: view.requestId }, false, view)
  }

  async run(inputs: ImportInput[], rawOptions: ImportOptions, expandDirectories = true, view?: ReturnType<typeof viewImportOptionsSchema.parse>, source: HistorySource = 'application'): Promise<ImportReport> {
    const options = importOptionsSchema.parse(rawOptions)
    const signature = createHash('sha256').update(JSON.stringify(view ? ['import_to_view', inputs, options, view] : ['import_to_library', inputs, options], (_k, v) => v instanceof Uint8Array ? createHash('sha256').update(v).digest('hex') : v)).digest('hex')
    const check = (old: string) => { if (old !== signature) throw new Error('[REQUEST_ID_CONFLICT] 同一 requestId 不能用于不同操作') }
    const receipt = this.lib.db.prepare('SELECT signature,result FROM main.operation_receipt WHERE request_id=?').get(options.requestId) as { signature: string; result: string } | undefined
    if (receipt) { checkRetiredRequest(receipt.signature); check(receipt.signature); return Promise.resolve(JSON.parse(receipt.result)) }
    const old = this.pending.get(options.requestId)
    if (old) { check(old.signature); return old.task }
    this.tasks.checkRequest(options.requestId, signature)
    const policy = readImportPolicy(this.lib)
    if (options.taskId) {
      if (expandDirectories) throw new Error('[TASK_INPUT_UNKNOWN] 任务清单导入要求逐项文件输入，请调用 importFiles')
      this.tasks.begin(options.taskId, inputs, options.requestId, signature)
    }
    this.admission.assertView(view?.viewId)
    const task = this.ingest.run(inputs, expandDirectories, apply => this.store.batch(() => {
      const result = this.history.run(r => `导入 · 收录 ${r.items.length} 项`, () => {
        this.admission.assertView(view?.viewId)
        const result = apply()
        if (view) {
          const allowed = new Set(result.items.filter(item => view.allowUnmatched.includes(item.index)).map(item => item.id))
          const strict = [...new Set(result.items.map(item => item.id))].filter(id => !allowed.has(id))
          const checked = this.admission.admitReady(strict, view.query)
          if (checked.rejected.length) throw new Error(`[VIEW_CHANGED] 正式收录检查未通过，本批仓库修改已回滚：${[...new Set(checked.rejected.map(r => r.reason))].join('；')}。请重新检查后选择。`)
        }
        return result
      }, { source, operation: view ? 'import_to_view' : 'import_to_library', requestId: options.requestId })
      this.lib.db.prepare('INSERT INTO main.operation_receipt VALUES (?,?,?,?)').run(options.requestId, signature, JSON.stringify(result), Date.now())
      if (options.taskId) this.tasks.finish(options.requestId, result)
      return result
    }), { key: `mcp:${options.requestId}`, signature }, { spaceId: options.spaceId, collect: options.collect ?? policy.collect, reuseFiles: true }).catch(error => {
      if (options.taskId && this.lib.db.open) this.tasks.fail(options.requestId, error)
      throw error
    }).finally(() => this.pending.delete(options.requestId))
    this.pending.set(options.requestId, { signature, task })
    return task
  }

  /** 首次打开核对存量，此后按同一空间连接的变更日志发现新候选。待办始终从仓库重读。 */
  private discover(space: FileSpace): void {
    const last = this.discoveredThrough.get(space)
    const through = space.db.transaction(() => {
      const head = Number(space.db.prepare('SELECT coalesce(max(seq),0) FROM space_changes').pluck().get())
      if (last === head) return head
      const recent = last !== undefined && last < head
      const scope = recent ? 'AND id IN (SELECT fileId FROM space_changes WHERE seq > ? AND seq <= ?)' : ''
      // 首次核对沿文件登记顺序顺读；避免按散列索引反复回表取身份。
      const ids = space.db.prepare(`SELECT id FROM files WHERE state='available'
        AND id NOT IN (SELECT file_id FROM recycled_files) ${scope} ORDER BY rowid`).pluck().all(...(recent ? [last, head] : []))
      if (ids.length) this.lib.db.prepare(`INSERT OR IGNORE INTO main.space_import_seen (space_id,file_id,state,error)
        SELECT @space,j.value,CASE WHEN a.entity_id IS NULL THEN 'pending' ELSE 'seen' END,NULL
        FROM json_each(@ids) j LEFT JOIN main.space_adoptions a ON a.space_id=@space AND a.file_id=j.value
        WHERE NOT EXISTS (SELECT 1 FROM main.space_import_seen i WHERE i.space_id=@space AND i.file_id=j.value)`)
        .run({ space: space.id, ids: JSON.stringify(ids) })
      return head
    })()
    this.discoveredThrough.set(space, through)
  }

  /** 调用方在导入队列中协调恢复、收录与版本扫描。 */
  scan(policy: ImportPolicy, spaceId?: string): ImportScan {
    const result: ImportScan = { collected: 0, remaining: 0, errors: [] }
    let attempted = 0
    const active = new Set(this.lib.files.bindings!.rows().filter(b => b.state === 'active').map(b => b.id))
    for (const rule of policy.spaces.filter(s => s.automatic && (spaceId === undefined || s.spaceId === spaceId) && active.has(s.spaceId))) {
      try {
        const space = this.lib.files.bindings!.open(rule.spaceId)
        this.discover(space)
        const waiting = this.lib.db.prepare(`SELECT i.file_id,i.error,a.entity_id FROM main.space_import_seen i
          LEFT JOIN main.space_adoptions a ON a.space_id=i.space_id AND a.file_id=i.file_id
          WHERE i.space_id=? AND i.state='pending'`).all(space.id) as { file_id: string; error: string | null; entity_id: string | null }[]
        if (!waiting.length) continue
        const pending = new Map(waiting.map(row => [row.file_id, row]))
        const files = space.db.prepare(`SELECT id,revision FROM files WHERE id IN (SELECT value FROM json_each(?))
          AND state='available' AND id NOT IN (SELECT file_id FROM recycled_files) ORDER BY rowid`)
          .all(JSON.stringify([...pending.keys()])) as { id: string; revision: number }[]
        result.remaining += files.length
        // 保持空间登记顺序，新候选排在已有错误的待办之前。
        files.sort((a, b) => Number(!!pending.get(a.id)!.error) - Number(!!pending.get(b.id)!.error))
        for (const file of files) {
          if (pending.get(file.id)!.entity_id) {
            this.seen(space.id, file.id); result.remaining--; continue
          }
          if (attempted >= 100) continue
          attempted++
          try {
            this.store.batch(() => {
              this.spaces.adopt({ spaceId: space.id, files: [file], requestId: `auto-${randomUUID()}` }, 'system')
              this.seen(space.id, file.id)
            })
            result.collected++; result.remaining--
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.lib.db.prepare("UPDATE main.space_import_seen SET error=? WHERE space_id=? AND file_id=?").run(message, space.id, file.id)
            if (result.errors.length < 20) result.errors.push({ spaceId: space.id, fileId: file.id, message })
          }
        }
      } catch (error) {
        if (result.errors.length < 20) result.errors.push({ spaceId: rule.spaceId, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }
  private seen(spaceId: string, fileId: string) { this.lib.db.prepare("UPDATE main.space_import_seen SET state='seen',error=NULL WHERE space_id=? AND file_id=?").run(spaceId, fileId) }
}
