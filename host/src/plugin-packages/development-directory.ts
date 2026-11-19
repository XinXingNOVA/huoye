import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { DevelopmentPackages } from './development'
import { developmentSelectionSchema, packageManifestSchema, type DevelopmentDirectoryState, type DevelopmentSelection, type DevelopmentSourceRow } from '../shared/external-plugins'

const configSchema = z.record(z.string(), z.object({ directory: z.string().optional(), directories: z.array(z.string()).max(32).optional(), toolchain: z.string().optional() }).strict())
const infoSchema = z.object({ id: packageManifestSchema.shape.id, title: packageManifestSchema.shape.title,
  version: packageManifestSchema.shape.version, description: z.string().optional() })
const ignored = new Set(['.git', 'node_modules', '.build-cache', 'artifacts', 'out', 'dist'])
type Session = { child?: ChildProcess; watchers?: FSWatcher[]; draft?: string[]; entries: string; failure?: string; errors: Map<string, string>; timer?: ReturnType<typeof setTimeout> }

/** 配置、候选与应用都以仓库路径为界；构建进程只产出包，不装配或执行插件。 */
export class DevelopmentDirectories {
  private config: z.infer<typeof configSchema>
  private file: string
  private cache: string
  private sessions = new Map<string, Session>()
  private stopping = new Map<string, Set<Promise<void>>>()
  private transitioning = new Set<string>()
  private compiled = new Map<string, { stamp: string; pack: Pick<ReturnType<DevelopmentPackages['inspect']>, 'manifest' | 'hash'> }>()
  constructor(private development: DevelopmentPackages, userData: string, private options: {
    reserved: string[]; defaultToolchain?: string; executable: string; runAsNode?: boolean; changed(): void
  }) {
    this.cache = join(userData, 'plugin-development', 'directory-builds'); mkdirSync(this.cache, { recursive: true })
    this.file = join(userData, 'plugin-development', 'directories.json')
    this.config = existsSync(this.file) ? configSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) : {}
  }
  private save(config = this.config) { const temp = this.file + '.tmp'; writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 }); renameSync(temp, this.file) }
  private output(root: string, source: string) {
    const key = createHash('sha256').update(resolve(root) + '\0' + source).digest('hex')
    return join(this.cache, key, 'plugin.rmplugin')
  }
  private toolchain(root: string) { return this.config[root]?.toolchain ?? this.options.defaultToolchain }
  private checkToolchain(path?: string): string | undefined {
    if (!path) return '请选择开发工具工程（本项目源码，已安装开发依赖）'
    for (const file of ['scripts/plugins/development-worker.ts', 'src/plugin-api/core/contracts.ts', 'node_modules/typescript/package.json', 'node_modules/esbuild/package.json']) {
      if (!existsSync(join(path, file))) return `开发工具工程缺少 ${file}；请安装依赖或选择完整工程`
    }
    return undefined
  }
  requireToolchain(path = this.options.defaultToolchain): string {
    const problem = this.checkToolchain(path)
    if (problem || !path) throw new Error('[TOOLCHAIN_UNAVAILABLE] ' + problem)
    return realpathSync(path)
  }
  private roots(root: string): string[] {
    const config = this.config[root]
    return config?.directories ?? (config?.directory ? [config.directory] : [])
  }
  async addDirectory(root: string, directory: string) {
    return this.setDirectories(root, [...this.roots(resolve(root)), directory])
  }
  async removeDirectory(root: string, directory: string) {
    return this.setDirectories(root, this.roots(resolve(root)).filter(path => path !== directory), false)
  }
  // 工程登记和工具链固定在同一次配置提交中。调用方已取得本库插件配置锁。
  async addProjectSource(root: string, source: string, toolchain: string, guard: () => void) {
    root = resolve(root)
    const pinned = this.config[root]?.toolchain
    if (pinned && realpathSync(pinned) !== toolchain) throw new Error('[TOOLCHAIN_CHANGED] 此库已选择其他开发工具工程')
    const directories = this.roots(root)
    if (directories.includes(source) && pinned === toolchain) return
    await this.setDirectories(root, [...directories, source], true, { toolchain, guard })
  }
  private async setDirectories(root: string, directories: string[], validate = true, project?: { toolchain: string; guard(): void }) {
    root = resolve(root)
    const unique = [...new Set(directories.map(path => validate ? realpathSync(path) : path))]
    if (unique.length > 32 || validate && unique.some(path => !statSync(path).isDirectory())) throw new Error('最多选择 32 个有效源码目录')
    this.transitioning.add(root)
    try {
      await this.close(root)
      project?.guard()
      const toolchain = project?.toolchain ?? this.config[root]?.toolchain
      const next = { ...this.config, [root]: { directories: unique, ...(toolchain ? { toolchain } : {}) } }
      this.save(next); this.config = next
    } finally { this.transitioning.delete(root); this.options.changed() }
  }
  async setDirectory(root: string, directory: string) {
    return this.setDirectories(root, [directory])
  }

  async setToolchain(root: string, path: string) {
    root = resolve(root); path = realpathSync(path)
    if (!this.config[root]) throw new Error('请先选择开发目录')
    const problem = this.checkToolchain(path); if (problem) throw new Error(problem)
    const draft = this.sessions.get(root)?.draft
    this.transitioning.add(root)
    try { await this.close(root); this.config[root].toolchain = path; this.save(); this.session(root).draft = draft }
    finally { this.transitioning.delete(root); this.options.changed() }
  }
  private session(root: string) {
    let session = this.sessions.get(root)
    if (!session) {
      session = { entries: '', errors: new Map() }; this.sessions.set(root, session)
      session.watchers = []
      for (const directory of this.roots(root)) try {
        const watcher = watch(directory, { recursive: true }, (_, name) => {
          const parts = String(name ?? '').split(/[\\/]/)
          if (parts.some(p => ignored.has(p))) return
          if (name && parts.length > 1 && parts.at(-1) !== 'plugin.json') return
          clearTimeout(session!.timer); session!.timer = setTimeout(() => this.options.changed(), 200)
        })
        // 发现仍有轻量轮询兜底；文件内容监听由构建进程负责。
        watcher.on('error', () => this.options.changed()); session.watchers.push(watcher)
      } catch { /* 目录失联在列表中显示，保留运行快照。 */ }
    }
    return session
  }
  private discover(root: string): { rows: DevelopmentSourceRow[]; problem?: string } {
    const rows: DevelopmentSourceRow[] = [], sources: string[] = []
    let problem: string | undefined
    for (const directory of this.roots(root)) try {
      const found = existsSync(join(directory, 'plugin.json')) ? [directory] : readdirSync(directory, { withFileTypes: true })
        .filter(e => e.isDirectory() && !ignored.has(e.name) && existsSync(join(directory, e.name, 'plugin.json')))
        .map(e => join(directory, e.name)).sort()
      for (const source of found) {
        const canonical = realpathSync(source)
        if (!sources.includes(canonical)) sources.push(canonical)
      }
    } catch (e) { problem = `开发目录不可用：${directory}：${String(e)}` }
    try {
      if (sources.length > 100) throw new Error('开发目录最多支持 100 个插件')
      for (const source of sources) {
        const row: DevelopmentSourceRow = { source, title: basename(source) }
        try {
          const path = join(source, 'plugin.json')
          if (statSync(path).size > 65536) throw new Error('插件声明超过 64 KB')
          Object.assign(row, infoSchema.parse(JSON.parse(readFileSync(path, 'utf8'))))
          if (this.options.reserved.includes(row.id!)) throw new Error('不能覆盖核心或内部插件 ID')
        } catch (e) { row.problem = `声明无效：${e instanceof Error ? e.message : String(e)}` }
        rows.push(row)
      }
      for (const row of rows) if (row.id && rows.filter(r => r.id === row.id).length > 1) row.problem = `目录中有重复插件 ID：${row.id}`
    } catch (e) { problem = `开发目录不可用：${e instanceof Error ? e.message : String(e)}` }
    for (const link of this.development.links(root).filter(l => l.source)) {
      let row = rows.find(r => r.source === link.source)
      if (!row) { row = { source: link.source!, id: link.manifest.id, title: link.manifest.title, version: link.manifest.version, problem: '源码不在当前目录中；取消勾选并应用可退出开发，当前快照继续保留' }; rows.push(row) }
      row.appliedHash = link.hash
      if (row.id !== link.manifest.id) row.problem = '插件 ID 已改变；请先取消勾选并应用，再启用新的身份'
    }
    return { rows, problem }
  }
  private syncWorker(root: string, rows: DevelopmentSourceRow[]) {
    if (this.stopping.get(root)?.size) return // 旧进程尚可写状态/产物，不能同时启动下一份写同一输出。
    const session = this.session(root)
    const selected = new Set([...(session.draft ?? []), ...rows.filter(r => r.appliedHash).map(r => r.source)])
    const entries = rows.filter(r => selected.has(r.source) && !r.problem).map(r => ({ source: r.source, output: this.output(root, r.source) }))
    const serialized = JSON.stringify(entries)
    if (session.entries === serialized || session.failure) return
    if (!entries.length) { session.entries = serialized; void this.stopWorker(root, session); return }
    const toolchain = this.toolchain(root)
    if (this.checkToolchain(toolchain)) return
    for (const entry of entries) if (!JSON.parse(session.entries || '[]').some((e: { source: string }) => e.source === entry.source)) {
      mkdirSync(join(entry.output, '..'), { recursive: true })
      writeFileSync(entry.output + '.status.json', JSON.stringify({ state: 'building', message: '等待开发构建…' }))
      session.errors.delete(entry.source)
    }
    session.entries = serialized
    if (!session.child) {
      const env = { ...process.env }; delete env.ELECTRON_RENDERER_URL
      if (this.options.runAsNode) env.ELECTRON_RUN_AS_NODE = '1'
      else delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(this.options.executable, [join(toolchain!, 'scripts/plugins/development-worker.ts')], { cwd: toolchain, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      session.child = child
      let diagnostics = ''
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-4000) })
      child.on('message', (message: { type?: string; source?: string; message?: string }) => {
        if (session.child !== child) return
        if (message.type === 'ready') child.send({ type: 'configure', entries: JSON.parse(session.entries) })
        if (message.type === 'failed' && message.source) session.errors.set(message.source, message.message ?? '无法启动源码监听')
        this.options.changed()
      })
      const failed = (message: string) => {
        if (session.child !== child) return
        session.child = undefined; session.failure = message; session.entries = ''; this.options.changed()
      }
      child.on('error', error => failed(`无法启动开发工具：${error.message}`))
      child.on('exit', code => failed(`开发构建进程已退出（${code}）。重新检测可重试。${diagnostics}`))
    } else if (session.child.connected) session.child.send({ type: 'configure', entries })
  }
  state(root: string, observeOnly = false): DevelopmentDirectoryState {
    root = resolve(root)
    if (!this.config[root] && !this.development.links(root).some(l => l.source)) return { rows: [] }
    const { rows, problem } = this.discover(root)
    if (this.transitioning.has(root)) return { directory: this.roots(root)[0], directories: this.roots(root), toolchain: this.toolchain(root), rows, problem: '正在更新开发目录，请稍候' }
    if (this.stopping.get(root)?.size) return { directory: this.roots(root)[0], directories: this.roots(root), toolchain: this.toolchain(root), rows, problem: '正在结束上一轮开发构建，请稍候' }
    if (!observeOnly) this.syncWorker(root, rows)
    const session = observeOnly ? this.sessions.get(root) : this.session(root)
    for (const row of rows) {
      const output = this.output(root, row.source)
      try { row.build = JSON.parse(readFileSync(output + '.status.json', 'utf8')) } catch { /* 未勾选不构建。 */ }
      if (session?.errors.has(row.source)) row.problem = session.errors.get(row.source)
      if (row.build?.state === 'ready' && !row.problem) try {
        const stat = statSync(output), stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        let cached = this.compiled.get(output)
        if (cached?.stamp !== stamp) {
          const { manifest, hash } = this.development.inspect(output)
          cached = { stamp, pack: { manifest, hash } }; this.compiled.set(output, cached)
        }
        const pack = cached.pack
        if (pack.manifest.id !== row.id) throw new Error('构建与当前声明的 ID 不一致')
        row.availableHash = pack.hash
      } catch (e) { row.problem = String(e) }
    }
    return { directory: this.roots(root)[0], directories: this.roots(root), toolchain: this.toolchain(root), rows,
      problem: problem ?? session?.failure ?? this.checkToolchain(this.toolchain(root)) }
  }
  async prepare(root: string, sources: unknown, retry = false) {
    root = resolve(root)
    const selected = z.array(z.string()).max(100).parse(sources), state = this.state(root)
    if (new Set(selected).size !== selected.length || selected.some(s => !state.rows.some(r => r.source === s))) throw new Error('开发选择已失效，请刷新列表')
    let session = this.session(root)
    if (retry || session.failure || session.errors.size) {
      this.transitioning.add(root)
      try { await this.close(root); session = this.session(root) } finally { this.transitioning.delete(root) }
    }
    session.draft = selected
    this.syncWorker(root, state.rows); this.options.changed()
  }
  apply(root: string, raw: DevelopmentSelection, scope?: readonly string[]) {
    root = resolve(root)
    const selection = developmentSelectionSchema.parse(raw), state = this.state(root)
    if (new Set(selection.map(s => s.source)).size !== selection.length) throw new Error('开发选择重复')
    if (selection.length && state.problem) throw new Error(state.problem)
    const prepared = selection.map(item => {
      const row = state.rows.find(r => r.source === item.source)
      if (!row || row.problem || row.build?.state !== 'ready' || row.availableHash !== item.hash) throw new Error(row?.problem ?? '构建已变化或未完成，请等待后重新应用')
      return { ...item, path: this.output(root, item.source) }
    })
    this.development.applySources(root, prepared, scope)
    this.session(root).draft = undefined
    this.syncWorker(root, this.discover(root).rows); this.options.changed()
  }
  async clear(root: string) {
    root = resolve(root); this.development.applySources(root, [])
    this.transitioning.add(root)
    try { await this.close(root); delete this.config[root]; this.save() }
    finally { this.transitioning.delete(root); this.options.changed() }
  }
  async close(root: string) {
    root = resolve(root)
    const session = this.sessions.get(root)
    if (session) {
      this.sessions.delete(root); clearTimeout(session.timer); session.watchers?.forEach(watcher => watcher.close())
      await this.stopWorker(root, session)
    }
    await Promise.all(this.stopping.get(root) ?? [])
  }
  private stopWorker(root: string, session: Session): Promise<void> {
    const child = session.child; session.child = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    const stopped = new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (child.connected) child.send({ type: 'stop' }); else child.kill()
    })
    let pending = this.stopping.get(root)
    if (!pending) this.stopping.set(root, pending = new Set())
    pending.add(stopped)
    void stopped.then(() => { pending.delete(stopped); if (!pending.size) this.stopping.delete(root); this.options.changed() })
    return stopped
  }
}
