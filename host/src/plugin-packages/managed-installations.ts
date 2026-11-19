import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { creationRequestSchema } from '../shared/application-creation'
import type { ManagedInstallation } from '../shared/application-management'
import type { PackagePreview, PackageRef } from '../shared/external-plugins'
import { PackageInstallations } from './installations'
import type { PackageManager } from './manager'
import type { SuiteCatalog } from './suites'

const LIMIT = 128 * 1024 * 1024
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const jobSchema = z.object({
  requestId: creationRequestSchema.shape.requestId, signature: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ name: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()).max(50),
  state: z.enum(['pending', 'completed', 'cancelled']), preview: z.custom<PackagePreview>(), error: z.string().optional(),
  suites: z.record(z.string(), z.string().nullable())
}).strict()
type Job = z.infer<typeof jobSchema>

/** 固定输入字节；复用人工安装器的逐项结果，安装许可仍由本机设置授予。 */
export class ManagedInstallations {
  constructor(private directory: string, private packages: PackageManager, private suites: SuiteCatalog) {}
  private root(id: string) { return join(this.directory, creationRequestSchema.parse({ requestId: id }).requestId) }
  private read(id: string): Job {
    const bytes = readFileSync(join(this.root(id), 'job.json'))
    if (bytes.length > 2 * 1024 * 1024) throw new Error('安装任务过大')
    return jobSchema.parse(JSON.parse(bytes.toString()))
  }
  private write(job: Job) {
    const file = join(this.root(job.requestId), 'job.json'), temp = file + '.' + randomUUID() + '.tmp'
    const data = JSON.stringify(job)
    if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('安装任务过大')
    try { writeFileSync(temp, data, { mode: 0o600 }); renameSync(temp, file) }
    finally { rmSync(temp, { force: true }) }
  }
  private ids() { return existsSync(this.directory) ? readdirSync(this.directory).filter(id => creationRequestSchema.safeParse({ requestId: id }).success && existsSync(join(this.root(id), 'job.json'))) : [] }
  private inspect(job: Job) {
    const paths = job.files.map((file, i) => {
      if (basename(file.name) !== file.name) throw new Error('安装快照文件名无效')
      const path = join(this.root(job.requestId), 'files', String(i), file.name)
      const bytes = readFileSync(path)
      if (bytes.length !== file.bytes || digest(bytes) !== file.hash) throw new Error('安装快照已改变，不能继续')
      return path
    })
    const installer = new PackageInstallations(() => this.packages, () => this.suites)
    const preview = installer.preview(0, paths)!
    // 自动化只安装归档中的确切版本，不采用套件界面默认的旧版替代选择。
    const choices = preview.items.filter(r => r.alternatives).map(r => ({ index: r.index, hash: r.hash! }))
    return { installer, preview, choices }
  }
  private refs(preview: PackagePreview): PackageRef[] {
    return [...new Map(preview.items.flatMap(r => r.manifest && r.hash ? [[r.hash, { manifest: r.manifest, hash: r.hash }] as const] : [])).values()]
  }
  private result(job: Job): ManagedInstallation {
    return { requestId: job.requestId, state: job.state, preview: job.preview, error: job.error,
      approvalRequired: this.refs(job.preview).filter(p => !this.packages.automationAllowed(p.hash)) }
  }
  list(): ManagedInstallation[] { return this.ids().map(id => this.read(id)).filter(j => j.state === 'pending').map(j => this.result(j)) }
  get(id: string): ManagedInstallation { return this.result(this.read(id)) }
  request(id: string, inputs: string[]): ManagedInstallation {
    const paths = inputs.map(p => resolve(p)), signature = digest(JSON.stringify(paths))
    if (existsSync(join(this.root(id), 'job.json'))) {
      const old = this.read(id)
      if (old.signature !== signature) throw new Error('[REQUEST_CONFLICT] 同一请求不能更换安装文件')
      return this.result(old)
    }
    const retained = this.ids().map(i => this.read(i)).filter(j => j.state === 'pending')
    if (retained.length >= 20) throw new Error('待处理安装任务过多，请先处理或取消')
    let total = retained.reduce((sum, j) => sum + j.files.reduce((s, f) => s + f.bytes, 0), 0)
    const files = paths.map(path => {
      const stat = statSync(path)
      total += stat.size
      if (!/\.(hyplugin|rmplugin|hysuite|rmsuite)$/i.test(path) || !stat.isFile() || stat.size > LIMIT || total > 2 * LIMIT) throw new Error('请选择插件或套件文件；待处理快照总量不能超过 256 MB')
      const bytes = readFileSync(path)
      if (bytes.length !== stat.size) throw new Error('来源文件正在改变，请重试')
      return { name: basename(path), bytes }
    })
    // 未有 job.json 的目录仅是本任务未确认的快照，清掉后重新捕获。
    rmSync(this.root(id), { force: true, recursive: true })
    files.forEach((f, i) => { const dir = join(this.root(id), 'files', String(i)); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, f.name), f.bytes, { mode: 0o600 }) })
    const job: Job = { requestId: id, signature, files: files.map(f => ({ name: f.name, hash: digest(f.bytes), bytes: f.bytes.length })), state: 'pending', preview: { token: '', items: [] }, suites: {} }
    try {
      job.preview = this.inspect(job).preview
      for (const s of job.preview.suites ?? []) {
        const prior = this.suites.list().find(p => p.manifest.id === s.id)
        job.suites[s.id] = prior?.hash ?? null
        if (s.previousVersion) throw new Error('AI 安装不更新已有套件，请在应用中处理套件更新')
      }
      this.write(job); return this.result(job)
    } catch (e) { rmSync(this.root(id), { force: true, recursive: true }); throw e }
  }
  approve(id: string) {
    const job = this.read(id)
    if (job.state !== 'pending') throw new Error('安装任务已结束')
    const { preview } = this.inspect(job)
    this.packages.setAutomationPermission(this.refs(preview), true)
    job.preview = preview
    if (job.error?.includes('PACKAGE_APPROVAL_REQUIRED')) job.error = undefined
    this.write(job)
  }
  cancel(id: string) {
    const job = this.read(id)
    if (job.state !== 'pending') return
    this.write({ ...job, state: 'cancelled' })
    rmSync(join(this.root(id), 'files'), { recursive: true, force: true })
  }
  install(id: string): ManagedInstallation {
    const job = this.read(id)
    if (job.state !== 'pending') return this.result(job)
    try {
      const { installer, preview, choices } = this.inspect(job)
      const missing = this.refs(preview).filter(p => !this.packages.automationAllowed(p.hash))
      if (missing.length) { job.preview = preview; job.error = '[PACKAGE_APPROVAL_REQUIRED] 请在应用 → AI 接入中批准这些确切版本，再继续同一安装请求'; this.write(job); return this.result(job) }
      for (const [id, before] of Object.entries(job.suites)) {
        const current = this.suites.list().find(s => s.manifest.id === id)
        // 自己先前已登记的同一快照可重试；其他套件变化由安装器拒绝。
        if ((current?.hash ?? null) !== before && !preview.suites?.some(s => s.id === id && s.status === 'existing')) throw new Error('套件已被其他操作改变，请重新请求安装')
      }
      job.preview = installer.install(0, preview.token, choices)
      for (const row of job.preview.items) if (row.hash && ['installed', 'existing', 'reused'].includes(row.status)) {
        try { this.packages.verify(row.hash) } catch (e) { row.status = 'failed'; row.error = String(e) }
      }
      job.error = undefined
      const failed = job.preview.items.some(r => ['invalid', 'failed'].includes(r.status)) || job.preview.suites?.some(s => ['failed', 'incomplete'].includes(s.status))
      if (!failed) job.state = 'completed'
      this.write(job)
      if (job.state === 'completed') rmSync(join(this.root(id), 'files'), { force: true, recursive: true })
    } catch (e) { job.error = String(e); this.write(job) }
    return this.result(job)
  }
}
