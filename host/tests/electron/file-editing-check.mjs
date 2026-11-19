import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const dir = mkdtempSync(join(tmpdir(), 'rm-file-editing-'))
console.log(dir)
const sourcesFile = resolve(process.env.RM_PLUGIN_SOURCES ?? '.plugin-sources.local.json')
const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'))
if (!sources['file-editing']) throw new Error('请在 RM_PLUGIN_SOURCES 或 .plugin-sources.local.json 配置 file-editing 独立工程')
const pack = join(dir, 'file-editing.rmplugin')
execFileSync(process.execPath, ['scripts/plugins/pack.ts', resolve(dirname(sourcesFile), sources['file-editing']), pack], { stdio: 'inherit' })
const helper = resolve('artifacts/checks/file-editing-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-space-forget-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir, pack], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
const toggle = resolve('artifacts/checks/file-editing-package.cjs')
await build({ stdin: { contents: `
import { readFileSync } from 'node:fs'
import { PackageManager } from './src/plugin-packages/manager'
import { openLibrary } from './src/core/library'
import { readBindings, setBinding } from './src/core/external-plugins'
import { PLUGINS } from './src/plugins/manifest'
const [root, userData, pack, action] = process.argv.slice(2), lib = openLibrary(root)
try {
  const manager = new PackageManager(userData, PLUGINS.map(p=>p.id)), binding = readBindings(lib).find(p=>p.manifest.id==='file-editing')
  if (action === 'uninstall') manager.uninstall(binding.hash)
  else if (action === 'enable') { const ref=manager.install(readFileSync(pack)); manager.grant(root,ref.hash); setBinding(lib,{...ref,enabled:true},PLUGINS) }
  else setBinding(lib,{...binding,enabled:false},PLUGINS)
} finally { lib.close() }
`, resolveDir: process.cwd() }, outfile: toggle, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
for (const flow of ['fileediting', 'fileeditingdisabled', 'fileeditinguninstalled', 'fileeditingresume']) {
  if (flow !== 'fileediting') execFileSync(process.execPath, [toggle, prepared.root, prepared.userData, pack, flow==='fileeditingdisabled'?'disable':flow==='fileeditinguninstalled'?'uninstall':'enable'], {stdio:'inherit'})
  const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, `${flow}.log`)); child.stdout.pipe(log); child.stderr.pipe(log)
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
  const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
  assert.equal(code, 0, readFileSync(join(dir, `${flow}.log`), 'utf8'))
  assert(existsSync(join(dir, `${flow}-result.json`)), readFileSync(join(dir, `${flow}.log`), 'utf8'))
}
console.log('受控文件编辑、保存、冲突、清理及重启验证通过：' + dir)
