import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { decodePackage, digest, packagePath, type Archive } from './archive'
import { packageManifestSchema, type InstalledPackage, type PackageRef } from '../shared/external-plugins'

interface State {
  packages: PackageRef[]
  grants: Record<string, string[]>
  blocked: Record<string, Record<string, string>>
  starting: string[]
  /** 本机交接给仓库的默认版本，可被用户更新。卸载后保留登记，避免重装。 */
  bundled?: Record<string, PackageRef>
  bundledRoots?: Record<string, string[]>
  automation?: PackageRef[]
}
/** 主进程持有的本机安装目录；仓库的启用意图由核心另存。所有修改同步提交，避免窗口间覆盖。 */
export class PackageManager {
  private release = new Map<string, PackageRef>()
  private state: State
  readonly root: string
  constructor(userData: string, private reserved: string[], private mode: 'release' | 'development' = 'release') {
    const root = join(userData, 'plugins')
    mkdirSync(root, { recursive: true })
    if (lstatSync(root).isSymbolicLink()) throw new Error('插件目录不能为符号链接')
    this.root = realpathSync(root)
    const file = join(this.root, 'registry.json')
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { packages: [], grants: {}, blocked: {}, starting: [] }
    if (!Array.isArray(this.state.packages) || !this.state.grants || !this.state.blocked || !Array.isArray(this.state.starting)) throw new Error('本机插件登记文件损坏，请保留文件并恢复备份')
    if (this.state.bundled && (typeof this.state.bundled !== 'object' || Array.isArray(this.state.bundled))) throw new Error('随应用插件登记损坏')
    for (const [id, ref] of Object.entries(this.state.bundled ?? {})) if (ref?.manifest?.id !== id) throw new Error('随应用插件登记 ID 不一致')
    if (this.state.bundledRoots && (typeof this.state.bundledRoots !== 'object' || Array.isArray(this.state.bundledRoots) || Object.values(this.state.bundledRoots).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string')))) throw new Error('随应用插件交接记录损坏')
    if (this.state.automation && !Array.isArray(this.state.automation)) throw new Error('自动化插件许可损坏')
    for (const p of [...this.state.packages, ...Object.values(this.state.bundled ?? {}), ...(this.state.automation ?? [])]) {
      packageManifestSchema.parse(p.manifest)
      if (!/^[a-f0-9]{64}$/.test(p.hash)) throw new Error('本机插件摘要无效')
    }
  }
  private save() {
    const file = join(this.root, 'registry.json'), temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); renameSync(temp, file)
  }
  provisionBundled(packages: Buffer[]) {
    this.state.bundled ??= {}
    const release = new Map<string, PackageRef>()
    for (const bytes of packages) {
      const { manifest, hash } = decodePackage(bytes), ref = { manifest, hash }
      release.set(hash, ref)
      const prior = this.state.bundled[manifest.id]
      if (prior) {
        // 旧库保留原绑定。尊重手动卸载、手动升级，以及同版不同内容的冲突。
        if (prior.hash === hash || !this.state.packages.some(p => p.hash === prior.hash)) continue
        const old = prior.manifest.version.split('.').map(BigInt), next = manifest.version.split('.').map(BigInt)
        const difference = next.findIndex((part, i) => part !== old[i])
        if (difference < 0 || next[difference] < old[difference]) continue
      }
      const conflict = this.state.packages.some(p => p.manifest.id === manifest.id && p.manifest.version === manifest.version && p.hash !== hash)
      if (!conflict) this.install(bytes)
      this.state.bundled[manifest.id] = ref
      try { this.save() } catch (e) {
        if (prior) this.state.bundled[manifest.id] = prior
        else delete this.state.bundled[manifest.id]
        throw e
      }
    }
    this.release = release
  }
  /** 当前发行清单验证过的确切内容，独立于用户的本机替换、卸载与仓库绑定。 */
  releasePackages(): PackageRef[] { return structuredClone([...this.release.values()]) }
  isRelease(hash: string): boolean { return this.release.has(hash) }
  bundled(): PackageRef[] { return structuredClone(Object.values(this.state.bundled ?? {})) }
  /** 只认可本地人工授予的确切摘要或应用随附登记，不因安装自动信任。 */
  automationAllowed(hash: string): boolean {
    return this.isRelease(hash) || !!this.state.automation?.some(p => p.hash === hash)
  }
  automationPermissions(): PackageRef[] { return structuredClone(this.state.automation ?? []) }
  setAutomationPermission(refs: PackageRef[], allowed: boolean) {
    for (const p of refs) { packageManifestSchema.parse(p.manifest); if (!/^[a-f0-9]{64}$/.test(p.hash)) throw new Error('无效摘要') }
    const previous = structuredClone(this.state)
    const hashes = new Set(refs.map(p => p.hash))
    this.state.automation = [...(this.state.automation ?? []).filter(p => !hashes.has(p.hash)), ...(allowed ? refs : [])]
    try { this.save() } catch (e) { this.state = previous; throw e }
  }
  directory(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('插件摘要无效')
    return join(this.root, 'packages', hash)
  }
  list(): PackageRef[] { return structuredClone(this.state.packages) }
  find(hash: string): PackageRef {
    const p = this.state.packages.find(p => p.hash === hash)
    if (!p) throw new Error('插件包未安装')
    return structuredClone(p)
  }
  isReserved(id: string): boolean { return this.reserved.includes(id) }
  inspect(bytes: Buffer): Archive {
    const pack = decodePackage(bytes)
    if (this.reserved.includes(pack.manifest.id)) throw new Error('不能覆盖基础模块或内置插件 ID')
    if (this.mode === 'release' && this.state.packages.some(p => p.manifest.id === pack.manifest.id && p.manifest.version === pack.manifest.version && p.hash !== pack.hash)) throw new Error('相同 ID 和版本已安装不同内容，请作者提升版本')
    return pack
  }
  install(bytes: Buffer): PackageRef {
    const pack = this.inspect(bytes)
    const ref = { manifest: pack.manifest, hash: pack.hash }
    if (this.state.packages.some(p => p.hash === pack.hash)) return ref
    const staging = join(this.root, 'staging', randomUUID()), dest = this.directory(pack.hash)
    mkdirSync(staging, { recursive: true })
    try {
      for (const [path, content] of pack.files) {
        const file = join(staging, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content, { mode: 0o600 })
      }
      writeFileSync(join(staging, 'package.rmplugin'), bytes, { mode: 0o600 })
      mkdirSync(dirname(dest), { recursive: true })
      // 未登记的同摘要目录是中断安装的残留，只在发布之前替换。
      if (existsSync(dest)) rmSync(dest, { recursive: true })
      renameSync(staging, dest)
      this.state.packages.push(ref)
      try { this.save() } catch (e) { this.state.packages.pop(); throw e }
      return ref
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  grant(root: string, hash: string) {
    this.grantMany(root, [hash])
  }
  /** 只读授权摘要，不暴露其他仓库路径或可能包含本机路径的加载错误。 */
  authorization(root: string, hash: string): 'granted' | 'approval-required' | 'blocked' {
    const key = resolve(root)
    if (!(this.state.grants[key] ?? []).includes(hash)) return 'approval-required'
    return this.state.blocked[key]?.[hash] ? 'blocked' : 'granted'
  }
  grantMany(root: string, hashes: string[]) {
    if (!hashes.length) return
    hashes.forEach(hash => this.find(hash))
    const previous = structuredClone(this.state)
    const key = resolve(root)
    this.state.grants[key] = [...new Set([...(this.state.grants[key] ?? []), ...hashes])]
    for (const hash of hashes) delete this.state.blocked[key]?.[hash]
    try { this.save() } catch (e) { this.state = previous; throw e }
  }
  block(root: string, hash: string, message: string) {
    const key = resolve(root)
    this.state.blocked[key] ??= {}
    this.state.blocked[key][hash] = message.slice(0, 1500)
    this.save()
  }
  begin(root: string): InstalledPackage[] {
    const key = resolve(root), interrupted = this.state.starting.includes(key)
    // 仅为应用自己交付的确切摘要做一次授权；不信任仓库或外部包自行声明的来源。
    this.state.bundledRoots ??= {}
    const seen = this.state.bundledRoots[key] ??= []
    for (const p of this.bundled()) if (!seen.includes(p.manifest.id)) {
      if (this.isRelease(p.hash) && this.state.packages.some(i => i.hash === p.hash)) this.state.grants[key] = [...new Set([...(this.state.grants[key] ?? []), p.hash])]
      seen.push(p.manifest.id)
    }
    if (interrupted) for (const hash of this.state.grants[key] ?? []) this.block(key, hash, '上次启动未完成，已跳过。可在设置中重试启用')
    this.state.starting = [...new Set([...this.state.starting, key])]; this.save()
    return this.available(root)
  }
  /** 预检读取真实授权／阻止状态，不标记启动或授予额外权限。 */
  available(root: string): InstalledPackage[] {
    const key = resolve(root)
    return this.state.packages.map(p => {
      let problem = this.state.blocked[key]?.[p.hash]
      if (!(this.state.grants[key] ?? []).includes(p.hash)) problem = '尚未在本机为此仓库启用'
      if (!problem) {
        try { this.verify(p.hash) } catch (e) { problem = `安装文件异常：${e instanceof Error ? e.message : e}` }
      }
      return { ...p, directory: this.directory(p.hash), problem }
    })
  }
  isStarting(root: string): boolean { return this.state.starting.includes(resolve(root)) }
  problem(root: string, hash: string): string | undefined { return this.state.blocked[resolve(root)]?.[hash] }
  ready(root: string) {
    this.state.starting = this.state.starting.filter(p => p !== resolve(root)); this.save()
  }
  verify(hash: string): void {
    const directory = this.directory(hash)
    const pack = decodePackage(readFileSync(this.file(hash, 'package.rmplugin')))
    if (pack.hash !== hash) throw new Error('安装包摘要变化')
    for (const [path, bytes] of pack.files) if (digest(readFileSync(this.file(hash, path))) !== digest(bytes)) throw new Error(`文件已变化：${path}`)
    if (realpathSync(directory) !== directory) throw new Error('安装目录不能为符号链接')
  }
  file(hash: string, path: string): string {
    if (!packagePath(path)) throw new Error('插件资源路径无效')
    const directory = this.directory(hash), file = join(directory, path)
    let part = directory
    if (lstatSync(part).isSymbolicLink()) throw new Error('插件目录不能为符号链接')
    for (const name of path.split('/')) { part = join(part, name); if (lstatSync(part).isSymbolicLink()) throw new Error('插件资源不能为符号链接') }
    const rel = relative(realpathSync(directory), realpathSync(file))
    if (rel.startsWith('..') || !lstatSync(file).isFile()) throw new Error('资源越界或不是文件')
    return file
  }
  /** 包曾关联/授权的全部本机路径，不受最近仓库列表的 20 项限制。 */
  knownRoots(): string[] {
    return [...new Set([...Object.keys(this.state.grants), ...Object.keys(this.state.blocked), ...Object.keys(this.state.bundledRoots ?? {})])]
  }
  /** 仅更新流程在所有绑定接续后调用。登记先提交，文件删除失败可幂等重试。 */
  finishReplacement(old: PackageRef, next: PackageRef) {
    this.find(next.hash)
    const previous = structuredClone(this.state)
    this.state.packages = this.state.packages.filter(p => p.hash !== old.hash)
    for (const key of Object.keys(this.state.grants)) this.state.grants[key] = this.state.grants[key].filter(h => h !== old.hash)
    for (const rows of Object.values(this.state.blocked)) delete rows[old.hash]
    if (this.state.bundled?.[old.manifest.id]?.hash === old.hash) this.state.bundled[old.manifest.id] = next
    try { this.save() } catch (e) { this.state = previous; throw e }
    rmSync(this.directory(old.hash), { recursive: true, force: true })
  }
  uninstall(hash: string) {
    this.find(hash)
    const previous = structuredClone(this.state)
    this.state.packages = this.state.packages.filter(p => p.hash !== hash)
    for (const key of Object.keys(this.state.grants)) this.state.grants[key] = this.state.grants[key].filter(h => h !== hash)
    try { this.save() } catch (e) { this.state = previous; throw e }
    // 先取消登记，再删除文件；中断残留不会被加载。
    rmSync(this.directory(hash), { recursive: true, force: true })
  }
}
