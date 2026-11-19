import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { libraryInitializationSchema, type CreationRecovery } from '../shared/library-creation'
import { pluginSelectionSchema } from '../shared/plugin-presets'
import { arrangementSchema } from '../plugin-packages/preset-applications'
import type { CreationPreview, CreateVaultInput } from '../shared/library-creation'
import type { CreationPreviewInput, CreationRuntime } from '../shared/application-creation'

const externalCreationSchema = z.object({
  namespace: z.string().min(1), requestId: z.string().min(8).max(128), signature: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['read', 'organize', 'admin']), projectToolchain: z.string().optional(), background: z.boolean()
}).strict()
export type ExternalCreation = z.infer<typeof externalCreationSchema>

const jobSchema = libraryInitializationSchema.extend({
  root: z.string().min(1), name: z.string().min(1), spaceRoot: z.string().optional(), spaceId: z.string().uuid().optional(),
  selection: pluginSelectionSchema, arrangement: arrangementSchema.optional(),
  title: z.string().optional(), error: z.string().optional(), external: externalCreationSchema.optional(),
  state: z.enum(['pending', 'completed', 'cancelled']).default('pending'),
  phase: z.enum(['planned', 'claimed', 'initialized', 'assembled']).default('planned')
}).strict()
export type CreationJob = z.infer<typeof jobSchema>
/** 应用接入只负责授权，共用创建服务负责固定计划、认领、初始化和接续。 */
export interface ApplicationCreationBackend {
  preview(input: CreationPreviewInput, root: string): CreationPreview
  prepare(input: CreateVaultInput, external: ExternalCreation): CreationJob
  find(namespace: string, requestId: string): CreationJob | undefined
  read(id: string): CreationJob
  resume(id: string, guard: () => void): Promise<void>
  cancel(id: string): void
  inspect(id: string): Promise<{ running: boolean; runtime: CreationRuntime }>
}
const markerName = '.creation.json'
export class LibraryCreations {
  constructor(private directory: string) {}
  private file(id: string) { return join(this.directory, z.string().uuid().parse(id) + '.json') }
  list(includeFinished = false): CreationJob[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => this.read(f.slice(0, -5))).filter(j => includeFinished || j.state === 'pending')
  }
  read(id: string) {
    const bytes = readFileSync(this.file(id))
    if (bytes.length > 2 * 1024 * 1024) throw new Error('建库接续记录过大')
    return jobSchema.parse(JSON.parse(bytes.toString('utf8')))
  }
  write(input: z.input<typeof jobSchema>) {
    const job = jobSchema.parse(input), file = this.file(job.id)
    if (Buffer.byteLength(JSON.stringify(job)) > 2 * 1024 * 1024) throw new Error('建库接续记录过大')
    mkdirSync(this.directory, { recursive: true })
    const tmp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(tmp, JSON.stringify(job), { flag: 'wx', mode: 0o600 }); renameSync(tmp, file) }
    finally { rmSync(tmp, { force: true }) }
    return job
  }
  describe(job: CreationJob): CreationRecovery {
    return { id: job.id, root: job.root, name: job.name, title: job.title, error: job.error }
  }
  /** 不接管已有仓库或隐藏的用户文件；只有本次的独占标记才允许续接。 */
  claim(job: CreationJob) {
    if (!existsSync(job.root)) mkdirSync(job.root)
    if (lstatSync(job.root).isSymbolicLink() || realpathSync(job.root) !== job.root) throw new Error('创建位置已改变，请检查目录')
    const marker = join(job.root, markerName)
    if (existsSync(marker)) {
      if (lstatSync(marker).isSymbolicLink()) throw new Error('创建标记不能是符号链接')
      const value = JSON.parse(readFileSync(marker, 'utf8'))
      if (value.id !== job.id || value.libraryId !== job.libraryId) throw new Error('目录属于另一项创建任务')
      return
    }
    if (readdirSync(job.root).some(f => f !== '.DS_Store')) throw new Error('目录已有内容，未覆盖；请检查后重新创建')
    writeFileSync(marker, JSON.stringify({ id: job.id, libraryId: job.libraryId }), { flag: 'wx', mode: 0o600 })
  }
  finish(job: CreationJob, state: 'completed' | 'cancelled' = 'completed') {
    // 外部请求保留终态，响应丢失／任务撤下后，同一 requestId 不能再次创建。
    if (job.external) this.write({ ...this.read(job.id), state })
    else rmSync(this.file(job.id), { force: true })
    this.clearMarker(job)
  }
  clearMarker(job: CreationJob) {
    const marker = join(job.root, markerName)
    try {
      if (!existsSync(job.root) || lstatSync(job.root).isSymbolicLink()) return
      if (existsSync(marker) && !lstatSync(marker).isSymbolicLink()) {
        const value = JSON.parse(readFileSync(marker, 'utf8'))
        if (value.id === job.id && value.libraryId === job.libraryId) rmSync(marker)
      }
    } catch (e) { console.warn('[creation] 临时标记待清理，初始化回执已保留', e) }
  }
}
