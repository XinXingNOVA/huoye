import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const target = process.argv[2]
if (!target) throw new Error('用法：npm run smoke:packaged -- <应用 exe 或 .app 路径>')
const bundle = resolve(target)
const executable = bundle.endsWith('.app')
  ? join(bundle, 'Contents/MacOS', execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim())
  : bundle
if (!existsSync(executable)) throw new Error(`应用不存在：${executable}`)
if (bundle.endsWith('.app')) {
  const legal = join(bundle, 'Contents/Resources/licenses')
  for (const name of ['manifest.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    if (!existsSync(join(legal, name))) throw new Error(`安装包缺少许可材料：${name}`)
  }
  const manifest = JSON.parse(await readFile(join(legal, 'manifest.json'), 'utf8'))
  if (!manifest.files.some(f => f.path.endsWith('/dist/LICENSES.chromium.html'))) throw new Error('安装包缺少 Chromium 许可')
  for (const file of manifest.files) {
    const hash = createHash('sha256').update(await readFile(join(legal, file.path))).digest('hex')
    if (hash !== file.sha256) throw new Error(`许可文件摘要不符：${file.path}`)
  }
}
const dir = await mkdtemp(join(tmpdir(), 'rm-distribution-'))
console.log(`独立验收目录：${dir}`)
const env = { ...process.env, RM_USER_DATA: join(dir, 'user'), CAPTURE_DIR: dir }
for (const key of ['LIBRARY_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_PATH', 'NODE_OPTIONS']) delete env[key]
const tools = join(dir, 'demo-tools.hyplugin')
execFileSync(process.execPath, [join(project, 'scripts/plugins/pack.ts'), join(project, 'examples/tool-views'), tools], { cwd: project, stdio: 'inherit' })
env.PLUGIN_PACKAGE = tools
for (const flow of ['distribution', 'distributionresume']) {
  let log = ''
  const child = spawn(executable, [], { cwd: dir, env: { ...env, CAPTURE_FLOW: flow }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk.toString() }); child.stderr.on('data', chunk => { log += chunk.toString() })
  const timer = setTimeout(() => child.kill(), 120_000)
  try {
    const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok) })
    await writeFile(join(dir, `${flow}.log`), log)
    const resultPath = join(dir, flow === 'distribution' ? 'result.json' : 'resume-result.json')
    if (!existsSync(resultPath)) throw new Error(`${flow} 未完成（退出码 ${code}），启动日志：${join(dir, `${flow}.log`)}`)
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    if (code !== 0 || !result.ok) throw new Error(`${flow} 失败：${JSON.stringify(result)}；日志 ${dir}`)
    console.log(JSON.stringify(result, null, 2))
  } finally { clearTimeout(timer) }
}
console.log(`安装目录验收通过，结果和截图保留在 ${dir}`)
