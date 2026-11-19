// 先 npm run build；项目外打包示例，仅访问独立临时仓库及用户配置。
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const dir = mkdtempSync(join(tmpdir(), 'rm-file-edits-')), source = join(dir, 'plugin-source'), pack = join(dir, 'file-editor.rmplugin')
console.log(dir)
cpSync(resolve('examples/file-editor'), source, { recursive: true })
execFileSync(process.execPath, ['scripts/plugins/pack.ts', source, pack], { stdio: 'inherit' })
const helper = resolve('artifacts/checks/file-edits-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-edits-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
execFileSync(process.execPath, [helper, dir, pack], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: 'fileedits' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
const log = createWriteStream(join(dir, 'electron.log')); child.stdout.pipe(log); child.stderr.pipe(log)
const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
assert.equal(code, 0, readFileSync(join(dir, 'electron.log'), 'utf8'))
assert(existsSync(join(dir, 'file-edits-result.json')), readFileSync(join(dir, 'electron.log'), 'utf8'))
assert.equal(JSON.parse(readFileSync(join(dir, 'file-edits-result.json'), 'utf8')).ok, true)
console.log('公共文件编辑、MCP 与插件示例验证通过：' + dir)
