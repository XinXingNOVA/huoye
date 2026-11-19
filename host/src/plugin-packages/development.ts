// 本机、按仓库的开发覆盖层；正式安装记录和仓库版本绑定保持独立。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { PackageManager } from './manager'
import { MAX_PACKAGE_BYTES } from './archive'
import { packageManifestSchema, type DevelopmentBuildState, type InstalledPackage, type PackageRef } from '../shared/external-plugins'

const refSchema = z.object({ manifest: packageManifestSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) })
const linkSchema = refSchema.extend({ path: z.string().min(1), source: z.string().min(1).optional(), previous: refSchema.optional() }).strict()
type Link = z.infer<typeof linkSchema>
const stateSchema = z.record(z.string(), z.record(z.string(), linkSchema))
const buildSchema = z.object({ state: z.enum(['building', 'ready', 'error', 'stopped']), message: z.string().max(6000).optional() })

export class DevelopmentPackages {
  readonly packages: PackageManager
  private state: z.infer<typeof stateSchema>
  private file: string
  constructor(userData: string, reserved: string[]) {
    const root = join(userData, 'plugin-development'); mkdirSync(root, { recursive: true })
    this.file = join(root, 'links.json')
    this.state = existsSync(this.file) ? stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : {}
    for (const links of Object.values(this.state)) for (const [id, link] of Object.entries(links)) if (id !== link.manifest.id) throw new Error('开发关联 ID 不一致')
    // 退役单包关联：只接续有源码目录的快照；正式绑定及仓库数据不变。
    for (const links of Object.values(this.state)) for (const [id, link] of Object.entries(links)) if (!link.source) delete links[id]
    this.packages = new PackageManager(root, reserved, 'development')
  }
  private commit(next: typeof this.state) {
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(temp, this.file)
    this.state = next
  }
  links(root: string): Link[] { return structuredClone(Object.values(this.state[resolve(root)] ?? {})) }
  private read(path: string) {
    if (statSync(path).size > MAX_PACKAGE_BYTES) throw new Error('开发包超过 16 MB')
    return readFileSync(path)
  }
  inspect(path: string) { return this.packages.inspect(this.read(path)) }
  /** 目录选择整批提交；源代码始终先构建成不可变快照，不改变正式绑定。 */
  applySources(root: string, selection: { source: string; path: string; hash: string }[], scope?: readonly string[]) {
    const key = resolve(root), next = structuredClone(this.state)
    if (scope && selection.some(s => !scope.includes(s.source))) throw new Error('开发选择超出本次来源范围')
    const prepared = selection.map(item => {
      const bytes = this.read(item.path), pack = this.packages.inspect(bytes), build = this.build(item.path)
      if (build?.state !== 'ready' || pack.hash !== item.hash) throw new Error('开发构建已变化或未就绪，请等待检查完成后重新应用')
      return { ...item, bytes, pack }
    })
    if (new Set(prepared.map(p => p.pack.manifest.id)).size !== prepared.length) throw new Error('开发插件 ID 重复')
    next[key] = Object.fromEntries(Object.entries(this.state[key] ?? {}).filter(([, link]) => scope && !scope.includes(link.source!)))
    if (prepared.some(p => next[key][p.pack.manifest.id])) throw new Error('开发插件身份与本次范围之外的来源冲突')
    for (const item of prepared) {
      const ref = this.packages.install(item.bytes), previous = this.state[key]?.[ref.manifest.id]
      this.packages.grant(root, ref.hash)
      next[key][ref.manifest.id] = { ...ref, path: item.path, source: item.source,
        ...(previous ? { previous: { manifest: previous.manifest, hash: previous.hash } } : {}) }
    }
    if (!Object.keys(next[key]).length) delete next[key]
    this.commit(next)
  }
  begin(root: string): InstalledPackage[] {
    return this.withLinks(root, this.packages.begin(root))
  }
  available(root: string): InstalledPackage[] {
    return this.withLinks(root, this.packages.available(root))
  }
  private withLinks(root: string, installed: InstalledPackage[]): InstalledPackage[] {
    return this.links(root).map(link => ({ ...link, directory: this.packages.directory(link.hash), development: true,
      problem: installed.find(p => p.hash === link.hash)?.problem ?? (!installed.some(p => p.hash === link.hash) ? '开发构建缓存缺失，请在开发目录重新构建并应用' : undefined) }))
  }
  private build(path: string): DevelopmentBuildState | undefined {
    try {
      const file = `${path}.status.json`
      if (statSync(file).size > 16384) return undefined
      return buildSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch { return undefined }
  }
  /** 运行中的旧快照继续保留；每个关联另留上一份快照，退出后下次清理。 */
  collect(running: PackageRef[] = []) {
    const keep = new Set(running.map(p => p.hash))
    for (const links of Object.values(this.state)) for (const link of Object.values(links)) { keep.add(link.hash); if (link.previous) keep.add(link.previous.hash) }
    for (const ref of this.packages.list()) if (!keep.has(ref.hash)) this.packages.uninstall(ref.hash)
  }
}
