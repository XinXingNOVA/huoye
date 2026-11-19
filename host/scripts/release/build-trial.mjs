// 源码套件的一键构建。首次运行仅需 Node / npm；不使用 shell 拼接，不发布。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs'
import { dirname, join, relative, resolve, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import builderConfig from '../../electron-builder.config.cjs'
import { pluginInventory, inventoryMarkdown } from './plugin-inventory.mjs'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const json = x => JSON.stringify(x, null, 2) + '\n'
const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function verifySource(root, sources) {
  const workspace = dirname(root), file = join(workspace, 'source-manifest.json')
  if (!existsSync(file)) return { status: 'working-tree-unpinned' }
  const manifest = readJson(file)
  for (const [id, dir] of Object.entries(sources)) if (realpathSync(dir) !== realpathSync(join(workspace, 'plugins', id))) throw new Error(`来源清单要求使用包内插件：${id}`)
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || f.path.includes('\\') || f.path.startsWith('/') || f.path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('源码清单路径无效')
    const path = join(workspace, f.path)
    if (!lstatSync(path).isFile() || digest(readFileSync(path)) !== f.sha256) throw new Error(`源码与交付清单不一致：${f.path}；请使用完整解压副本，不要改源码绕过构建错误`)
  }
  return { status: 'verified', host: manifest.host, plugins: manifest.plugins, manifestSha256: digest(readFileSync(file)) }
}
export function findNpm(env = process.env) {
  const candidates = [env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    candidates.push(join(dir, 'node_modules/npm/bin/npm-cli.js'))
    const shim = join(dir, 'npm')
    if (existsSync(shim)) candidates.push(realpathSync(shim))
  }
  const found = candidates.find(p => p && p.endsWith('npm-cli.js') && existsSync(p))
  if (!found) throw new Error('未找到 npm-cli.js，请安装带 npm 的 Node.js 24+，重新打开终端再运行')
  return found
}
export async function execute(command, logFile) {
  const log = createWriteStream(logFile)
  // 日志保留完整输出；终端每阶段有明确名称，也流式显示长下载／编译进度。
  const child = spawn(process.execPath, command.args, { cwd: command.cwd, env: command.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logError
  log.on('error', e => { logError = e; child.kill() })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log.write(data); process.stdout.write(data) })
  let error
  try {
    await new Promise((ok, fail) => { child.once('error', fail); child.once('close', (code, signal) => code === 0 ? ok() : fail(new Error(`退出码 ${code ?? signal}`))) })
  } catch (e) { error = e }
  finally { if (!log.destroyed) await new Promise((ok, fail) => { log.once('error', fail); log.end(ok) }) }
  if (logError) throw logError
  if (error) throw error
}
export async function runSteps(steps, output, report, run = execute) {
  mkdirSync(join(output, 'logs'), { recursive: true })
  const save = () => writeFileSync(join(output, 'build-result.json'), json(report))
  for (const [index, step] of steps.entries()) {
    const entry = { name: step.name, status: 'running', log: `logs/${String(index + 1).padStart(2, '0')}-${step.id}.log` }
    report.steps.push(entry); save(); console.log(`\n[${index + 1}/${steps.length}] ${step.name}`)
    try {
      if (step.action) { await step.action(); writeFileSync(join(output, entry.log), 'completed\n') }
      else await run(step, join(output, entry.log))
      entry.status = 'passed'; save()
    } catch (e) {
      entry.status = 'failed'; entry.error = e.message; report.status = 'failed'; save()
      if (!existsSync(join(output, entry.log))) writeFileSync(join(output, entry.log), e.message + '\n')
      throw new Error(`${step.name}失败：${e.message}\n记录：${join(output, 'build-result.json')}\n日志：${join(output, entry.log)}`)
    }
  }
}
function getSources(root) {
  const file = resolve(process.env.RM_PLUGIN_SOURCES ?? (existsSync(join(root, '.plugin-sources.local.json')) ? join(root, '.plugin-sources.local.json') : join(root, '.plugin-sources.example.json')))
  if (!existsSync(file)) throw new Error('缺少插件来源配置；请从完整源码套件运行，或设置 RM_PLUGIN_SOURCES')
  const mapping = readJson(file), ids = readJson(join(root, 'packaging/source-profile.json')).plugins
  return Object.fromEntries(ids.map(id => {
    if (typeof mapping[id] !== 'string') throw new Error(`缺少本版插件来源：${id}`)
    return [id, resolve(dirname(file), mapping[id])]
  }))
}
function describe(root, sources) {
  const paths = []
  for (const prefix of ['src/plugins', 'packaging/plugins']) for (const id of readdirSync(join(root, prefix))) {
    for (const name of ['plugin.json', 'distribution.json']) if (existsSync(join(root, prefix, id, name))) paths.push(`host/${prefix}/${id}/${name}`)
  }
  const read = path => {
    if (path.startsWith('host/')) return readJson(join(root, path.slice(5)))
    const [, id, name] = path.split('/'); return readJson(join(sources[id], name))
  }
  return pluginInventory(read, paths)
}
function checksumTree(root, output, prefix = '') {
  const sums = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) sums.push(...checksumTree(root, output, name))
    else if (entry.isFile()) sums.push(`${digest(readFileSync(join(root, name)))}  ${relative(output, root).split('\\').join('/')}/${name}\n`)
    else throw new Error(`交付产物不能是链接：${name}`)
  }
  return sums
}
export async function buildTrial(mode, root = project) {
  if (!['windows', 'prepare'].includes(mode)) throw new Error('用法：build-trial.mjs <windows|prepare>')
  if (+process.versions.node.split('.')[0] < 24) throw new Error('需要 Node.js 24 或更高版本')
  if (mode === 'windows' && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('Windows 安装包必须在 Windows x64 + x64 Node.js 上生成；其他系统可运行 prepare 验证公共构建')
  const sources = getSources(root), source = verifySource(root, sources), inventory = describe(root, sources), npm = findNpm()
  // 未锁依赖不能临时 install 一个新版本冒充本版。无独立依赖的纯 UI 包可直接使用宿主工具链。
  for (const [id, dir] of Object.entries(sources)) {
    const pkg = readJson(join(dir, 'package.json'))
    if (!existsSync(join(dir, 'package-lock.json')) && (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length)) throw new Error(`插件缺少依赖锁文件：${id}`)
  }
  const parent = join(root, 'artifacts/trials'); mkdirSync(parent, { recursive: true })
  const output = mkdtempSync(join(parent, `${inventory.hostVersion}-${mode}-`))
  const bundled = join(output, 'bundled-plugins'), optional = join(output, 'optional-plugins')
  const checked = join(output, '.compiled-plugins')
  mkdirSync(bundled)
  writeFileSync(join(output, 'plugins.json'), json(inventory)); writeFileSync(join(output, '插件功能清单.md'), inventoryMarkdown(inventory))
  const env = { ...process.env }
  for (const key of ['RM_PLUGIN_BUNDLE', 'RM_PLUGIN_SOURCES', 'RM_PLUGIN_TOOLCHAIN', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LIBRARY_PATH', 'NODE_PATH', 'NODE_OPTIONS', 'RM_TEST_EXTERNAL']) delete env[key]
  const report = { format: 1, status: 'running', mode, version: inventory.hostVersion, platform: process.platform, arch: process.arch, node: process.version, source, steps: [], packagedSmoke: 'not-run', manualAcceptance: 'pending', licenseReview: 'pending' }
  const command = (id, name, args, cwd = root) => ({ id, name, args, cwd, env })
  const steps = [command('host-install', '安装宿主锁定依赖', [npm, 'ci', '--no-audit', '--no-fund'])]
  for (const [id, dir] of Object.entries(sources)) if (existsSync(join(dir, 'package-lock.json'))) steps.push(command(`install-${id}`, `安装插件依赖：${id}`, [npm, 'ci', '--no-audit', '--no-fund'], dir))
  steps.push(command('typecheck', '宿主类型检查', [npm, 'run', 'typecheck']), command('portable-tests', '平台与插件安装回归', [npm, 'run', 'test:portable']))
  for (const p of inventory.plugins.filter(p => !p.bundled)) steps.push(command(`pack-${p.id}`, `验证可选插件源码：${p.id}`, [join(root, 'scripts/plugins/pack.ts'), sources[p.id], join(checked, `${p.id}.hyplugin`)], sources[p.id]))
  steps.push(command('licenses', '收集随包许可材料', [npm, 'run', 'licenses:prepare']))
  steps.push(command('build', '从发行套件构建应用', [npm, 'run', 'build']))
  steps.push({ id: 'catalog', name: '核对安装包随附内容并生成交付清单', action: async () => {
    const { decodePackage } = await import(pathToFileURL(join(root, 'src/plugin-packages/archive.ts')).href)
    // 源码套件从零运行，ZIP 库在前面的 npm ci 完成后才可加载。
    const { releaseOptionalPlugins } = await import('./optional-plugins.mjs')
    const { archive } = releaseOptionalPlugins(root, output, 'optional-plugins')
    report.optionalArchive = relative(output, archive)
    const shipped = join(root, 'out/main/plugins')
    const catalog = readJson(join(shipped, 'catalog.json'))
    if (catalog.length !== inventory.plugins.filter(p => p.bundled).length) throw new Error('发行套件与附带清单数量不一致')
    report.packages = inventory.plugins.map(p => {
      const file = `${p.id}.hyplugin`, bytes = readFileSync(join(p.bundled ? shipped : optional, file)), pack = decodePackage(bytes)
      if (pack.manifest.id !== p.id || pack.manifest.version !== p.version) throw new Error(`产物身份／版本错误：${p.id}`)
      if (p.bundled) {
        if (!catalog.some(row => row.file === file && row.hash === pack.hash)) throw new Error(`发行套件缺少对应摘要：${file}`)
        writeFileSync(join(bundled, file), bytes)
      } else {
        const built = decodePackage(readFileSync(join(checked, file)))
        if (JSON.stringify(built.manifest) !== JSON.stringify(pack.manifest)) throw new Error(`可选发行包与源码声明不符：${p.id}`)
      }
      return { id: p.id, version: p.version, bundled: p.bundled, defaultEnabled: p.defaultEnabled, sha256: pack.hash }
    })
    copyFileSync(join(shipped, 'catalog.json'), join(bundled, 'catalog.json'))
    copyFileSync(join(shipped, 'suites.json'), join(bundled, 'suites.json'))
    rmSync(checked, { recursive: true })
  } })
  if (mode === 'windows') {
    const applications = join(output, 'applications')
    steps.push(command('electron', '准备 Electron 运行程序', [join(root, 'node_modules/electron/install.js')]), command('media', '准备并校验 Windows 媒体工具', [join(root, 'scripts/release/prepare-media.mjs')]),
      command('package', '生成 Windows x64 安装程序与 ZIP', [join(root, 'node_modules/electron-builder/cli.js'), '--config', join(root, 'electron-builder.config.cjs'), '--win', '--x64', `--config.directories.output=${applications}`, '--publish', 'never']),
      command('smoke', '打包应用新文件导入与重启验收', [join(root, 'scripts/release/smoke-packaged.mjs'), join(applications, 'win-unpacked', `${builderConfig.win.executableName}.exe`)]))
  }
  steps.push({ id: 'finalize', name: '整理交付说明与摘要', action: async () => {
    writeFileSync(join(output, 'Windows试用说明.md'), readFileSync(join(root, 'docs/user/Windows试用说明.md'), 'utf8').replace('../development/Windows-AI构建指南.md', 'Windows-AI构建指南.md'))
    copyFileSync(join(root, 'docs/development/Windows-AI构建指南.md'), join(output, 'Windows-AI构建指南.md'))
    const sums = [...checksumTree(bundled, output), ...checksumTree(optional, output)]
    if (mode === 'windows') {
      report.packagedSmoke = 'passed'
      for (const [template, ext] of [[builderConfig.nsis.artifactName, 'exe'], [builderConfig.win.artifactName, 'zip']]) {
        const name = template.replace('${version}', inventory.hostVersion).replace('${arch}', 'x64').replace('${ext}', ext)
        if (!existsSync(join(output, 'applications', name))) throw new Error(`缺少交付应用：${name}`)
      }
      for (const name of readdirSync(join(output, 'applications')).filter(n => /\.(exe|zip)$/.test(n)).sort()) sums.push(`${digest(readFileSync(join(output, 'applications', name)))}  applications/${name}\n`)
    }
    for (const name of [report.optionalArchive, 'plugins.json', '插件功能清单.md', 'Windows试用说明.md', 'Windows-AI构建指南.md']) sums.push(`${digest(readFileSync(join(output, name)))}  ${name}\n`)
    writeFileSync(join(output, 'SHA256SUMS.txt'), sums.join(''))
  } })
  await runSteps(steps, output, report)
  report.status = mode === 'windows' ? 'built-and-smoke-tested' : 'prepared-not-packaged'
  writeFileSync(join(output, 'build-result.json'), json(report))
  appendFileSync(join(output, 'SHA256SUMS.txt'), `${digest(readFileSync(join(output, 'build-result.json')))}  build-result.json\n`)
  console.log(`\n${mode === 'windows' ? '构建与打包冒烟完成，仍需安装器和人工试用验收' : '公共构建完成；未生成或验证 Windows 安装包'}：${output}`)
  return output
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 3) throw new Error('只接受 windows 或 prepare 参数'); await buildTrial(process.argv[2]) }
  catch (e) { console.error(e.message); process.exitCode = 1 }
}
