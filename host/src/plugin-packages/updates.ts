import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { bindingSchema, canonical, packageManifestSchema, type PackageRef } from '../shared/external-plugins'
import type { PackageUpdateJob, PackageUpdatePreview, UpdateLibrary } from '../shared/plugin-updates'
import type { PackageManager } from './manager'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const ref = z.object({ manifest: packageManifestSchema, hash })
const row = z.object({ root: z.string(), id: z.string(), name: z.string(), binding: bindingSchema })
const jobSchema = z.object({ token: z.string().uuid(), previous: ref, next: ref, libraries: z.array(row), blockers: z.array(z.string()), phase: z.enum(['prepared','switching','removing','complete']), error: z.string().optional() })
export interface UpdateEnvironment {
  scan(old: PackageRef, next: PackageRef): Promise<{ libraries: UpdateLibrary[]; blockers: string[] }>
  prepare(libraries: UpdateLibrary[]): Promise<void>
  check(library: UpdateLibrary, old: PackageRef, next: PackageRef): Promise<void>
  replace(library: UpdateLibrary, old: PackageRef, next: PackageRef): Promise<void>
  reload(library: UpdateLibrary, next: PackageRef): Promise<void>
  resume(): void
}
/** 明确确认的单次替换意图。跨仓库不能假装数据库事务：部分提交后只向前接续。 */
export class PackageUpdates {
  private previews = new Map<number, { preview: PackageUpdatePreview; bytes: Buffer }>()
  busy = false
  constructor(private directory: string, private packages: PackageManager, private environment: UpdateEnvironment) {}
  private get file() { return join(this.directory, 'update.json') }
  private get candidate() { return join(this.directory, 'candidate.rmplugin') }
  read(): PackageUpdateJob | undefined {
    if (!existsSync(this.file)) return undefined
    return jobSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
  }
  private save(job: PackageUpdateJob) {
    mkdirSync(this.directory, { recursive: true })
    const temp = this.file + '.tmp'
    writeFileSync(temp, JSON.stringify(jobSchema.parse(job)), { mode: 0o600 }); renameSync(temp, this.file)
  }
  assertIdle() {
    const job = this.read()
    if (this.busy || (job && job.phase !== 'complete')) throw new Error('还有插件更新未完成，请先在应用插件设置中继续更新')
  }
  clearPreview(owner: number, token?: string) {
    if (!token || this.previews.get(owner)?.preview.token === token) this.previews.delete(owner)
  }
  async preview(owner: number, oldHash: string, bytes: Buffer): Promise<PackageUpdatePreview> {
    this.assertIdle()
    const previous = this.packages.find(oldHash), pack = this.packages.inspect(bytes)
    if (pack.manifest.id !== previous.manifest.id) throw new Error('请选择同一个插件的新版本')
    const a = previous.manifest.version.split('.').map(Number), b = pack.manifest.version.split('.').map(Number)
    const at = a.findIndex((n, i) => n !== b[i])
    if (at < 0 || a[at] > b[at]) throw new Error('更新需要更高版本；多版本并存请使用添加插件')
    const next = { manifest: pack.manifest, hash: pack.hash }
    const preview = { token: randomUUID(), previous, next, ...await this.environment.scan(previous, next) }
    this.previews.set(owner, { preview, bytes: Buffer.from(bytes) })
    return structuredClone(preview)
  }
  async start(owner: number, token: string) {
    this.assertIdle()
    const pending = this.previews.get(owner)
    if (!pending || pending.preview.token !== token) throw new Error('更新预览已失效，请重新选择')
    const fresh = await this.environment.scan(pending.preview.previous, pending.preview.next)
    this.assertIdle()
    if (fresh.blockers.length) throw new Error(fresh.blockers.join('\n'))
    if (canonical(fresh.libraries) !== canonical(pending.preview.libraries)) throw new Error('受影响仓库已变化，请重新预览')
    mkdirSync(this.directory, { recursive: true })
    const temp = this.candidate + '.tmp'
    writeFileSync(temp, pending.bytes, { mode: 0o600 }); renameSync(temp, this.candidate)
    this.save({ ...pending.preview, phase: 'prepared', blockers: [] })
    this.previews.delete(owner)
    return this.run(token)
  }
  async run(token: string): Promise<PackageUpdateJob> {
    if (this.busy) throw new Error('正在更新，请稍候')
    const job = this.read()
    if (!job || job.token !== token) throw new Error('更新任务已变化')
    if (job.phase === 'complete') { rmSync(this.candidate, { force: true }); return job }
    this.busy = true
    try {
      const next = this.packages.install(readFileSync(this.candidate))
      if (next.hash !== job.next.hash) throw new Error('待更新文件已变化')
      this.packages.verify(next.hash)
      const fresh = await this.environment.scan(job.previous, job.next)
      if (fresh.blockers.length) throw new Error(fresh.blockers.join('\n'))
      // 新出现的旧版使用者必须重新确认，不能绕过原影响清单。
      if (fresh.libraries.some(l => !job.libraries.some(j => j.root === l.root && j.id === l.id && canonical(j.binding) === canonical(l.binding)))) throw new Error('出现新的旧版本绑定，请恢复原选择后重试')
      if (job.phase === 'removing' && fresh.libraries.length) throw new Error('旧版仍被引用，未删除')
      if (job.phase !== 'removing') {
        await this.environment.prepare(job.libraries)
        for (const library of job.libraries) await this.environment.check(library, job.previous, job.next)
        job.phase = 'switching'; delete job.error; this.save(job)
        for (const library of job.libraries) {
          if (library.binding.enabled) this.packages.grant(library.root, job.next.hash)
          await this.environment.replace(library, job.previous, job.next)
          await this.environment.reload(library, job.next)
        }
        const final = await this.environment.scan(job.previous, job.next)
        if (final.blockers.length || final.libraries.length) throw new Error([...final.blockers, '仍有旧版本引用，旧包尚未删除'].join('\n'))
        job.phase = 'removing'; this.save(job)
      }
      // removing 接续仍需重新确认没有新旧引用；上面的 scan 已执行。
      this.packages.finishReplacement(job.previous, job.next)
      job.phase = 'complete'; delete job.error; this.save(job)
      rmSync(this.candidate, { force: true })
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
      this.save(job)
    } finally { this.busy = false; this.environment.resume() }
    return structuredClone(job)
  }
  cancel(token: string) {
    if (this.busy) throw new Error('正在更新')
    const job = this.read()
    if (!job || job.token !== token) return
    if (job.phase === 'removing') throw new Error('已完成所有仓库更新，请继续完成旧包清理')
    // switching 只能放弃剩余步骤；保留两版及已提交的选择，不声称撤回新版本的数据影响。
    rmSync(this.file, { force: true }); rmSync(this.candidate, { force: true })
  }
}
