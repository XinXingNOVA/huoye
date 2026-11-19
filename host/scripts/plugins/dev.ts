// 开发监听只产出包；应用仍负责按仓库授权和装配，不在发布程序内运行编译器。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packPlugin } from './pack.ts'
import { decodePackage } from '../../src/plugin-packages/archive.ts'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function atomic(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, data); renameSync(temporary, path) } finally { rmSync(temporary, { force: true }) }
}
export async function startPluginDevelopment(directory: string, destination?: string, options: {
  interval?: number; log?: (message: string) => void; onStatus?: () => void
  serialize?: (build: () => Promise<void>) => Promise<void>
} = {}) {
  const source = realpathSync(directory), key = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const requested = resolve(destination ?? join(project, '.build-cache', 'development', `${basename(source)}-${key}`, 'plugin.rmplugin'))
  mkdirSync(dirname(requested), { recursive: true })
  const output = join(realpathSync(dirname(requested)), basename(requested))
  const relativeOutput = relative(source, output).split(sep).join('/')
  if (!isAbsolute(relativeOutput) && relativeOutput.startsWith('assets/')) throw new Error('开发包输出不能放在插件 assets 中')
  const log = options.log ?? console.log
  let watchFailure: string | undefined
  const status = (state: string, message?: string) => {
    if (watchFailure && state !== 'stopped') { state = 'error'; message = watchFailure }
    atomic(`${output}.status.json`, JSON.stringify({ state, message, at: Date.now() })); options.onStatus?.()
  }
  let inputs: string[] = [], fingerprint = '', closed = false, task: Promise<void> | undefined
  const ignored = new Set(['.git', 'node_modules', '.build-cache', 'artifacts', 'out', 'dist'])
  const stamp = () => {
    const hash = createHash('sha256')
    const visit = (path: string, root = false) => {
      if (path === output || path.startsWith(`${output}.`)) return
      hash.update(path)
      if (!existsSync(path)) { hash.update('missing'); return }
      const info = lstatSync(path)
      if (info.isSymbolicLink()) { hash.update(String(info.mtimeMs)); return }
      if (info.isDirectory()) {
        for (const name of readdirSync(path).sort()) {
          if (ignored.has(name)) continue
          visit(join(path, name))
        }
      } else if (info.isFile()) hash.update(readFileSync(path))
    }
    visit(source, true)
    // 已解析的 SDK、依赖类型和第三方入口也参与失效；不遍历整个 node_modules。
    for (const file of inputs) {
      if (file.startsWith(source + '/') && !file.includes('/node_modules/')) continue
      try { const s = statSync(file); hash.update(`${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`) } catch { hash.update(`${file}:missing`) }
    }
    return hash.digest('hex')
  }
  const build = async () => {
    if (closed) return
    const before = stamp()
    if (before === fingerprint) { status('ready', '源码内容未变化，当前构建可用'); return }
    fingerprint = before
    const temporary = `${output}.${randomUUID()}.building`
    status('building', '正在检查并构建…')
    try {
      let dependencies: string[] = []
      await packPlugin(source, temporary, files => { dependencies = files })
      if (stamp() !== before) { fingerprint = ''; schedule(); return } // 写代码时不发布混合构建。
      const bytes = readFileSync(temporary), pack = decodePackage(bytes)
      if (closed) return
      atomic(output, bytes)
      inputs = [...new Set(dependencies.flatMap(file => [file, join(dirname(file), 'package.json')]))]
      fingerprint = stamp()
      status('ready', `${pack.manifest.title} · ${pack.hash.slice(0, 8)}`)
      log(`构建成功 ${pack.hash.slice(0, 8)}；在应用中重新加载开发插件。`)
    } catch (error) {
      fingerprint = ''
      if (!closed) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 6000)
        status('error', message); log(`构建失败，保留上次成功的包：\n${message}`)
      }
    } finally { rmSync(temporary, { force: true }) }
  }
  let dirty = false, timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    if (closed) return
    if (task) { dirty = true; return }
    dirty = false
    task = (options.serialize ? options.serialize(build) : build()).catch(error => { status('error', `监听失败：${String(error)}`); log(String(error)) }).finally(() => { task = undefined; if (dirty) schedule() })
  }
  const schedule = () => {
    if (closed) return
    dirty = true; clearTimeout(timer)
    // 文件一改变就标记待检查，不能在去抖期间把旧产物当成新源码的成功构建。
    status('building', '源码有变化，等待检查并构建…')
    timer = setTimeout(tick, options.interval ?? 250)
  }
  const watcher = watch(source, { recursive: true }, (_, file) => {
    const parts = String(file ?? '').split(/[\\/]/)
    if (parts.some(p => ignored.has(p))) return
    const path = resolve(source, String(file ?? ''))
    // macOS FSEvents 也可能报告被监听目录自身的 basename；输出包的原子替换会触发它。
    if (String(file) === basename(source) && !existsSync(path)) return
    if (path === output || path.startsWith(`${output}.`)) return
    schedule()
  })
  watcher.on('error', error => { watchFailure = `源码监听失败：${error.message}`; status('error', watchFailure) })
  const dependencyStamp = () => inputs.filter(file => !file.startsWith(source + sep) || file.includes('node_modules')).map(file => {
    try { const s = statSync(file); return `${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch { return `${file}:missing` }
  }).join('\n')
  let dependencies = ''
  // 仅检查已解析的外部依赖元数据；不再定时读取整棵源码树。
  const dependencyTimer = setInterval(() => { const next = dependencyStamp(); if (dependencies && next !== dependencies) schedule(); dependencies = next }, 2000)
  log(`开发包：${output}\n在当前仓库设置中选择此插件的源码目录，勾选后应用并重载；此命令仅独立监听构建。`)
  tick(); await task
  return { output, async close() { closed = true; watcher.close(); clearTimeout(timer); clearInterval(dependencyTimer); await task; status('stopped', '监听已停止，保留最近成功构建') } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , source, output] = process.argv
  if (!source) throw new Error('用法：npm run plugin:dev -- <插件源码目录> [固定输出.hyplugin]')
  const watcher = await startPluginDevelopment(source, output)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void watcher.close().then(() => { process.exitCode = 0 }) })
}
