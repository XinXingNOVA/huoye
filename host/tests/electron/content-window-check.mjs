// 基础构建；包、仓库、应用配置全部临时，不依赖业务插件工程。
import assert from 'node:assert/strict'
import { pluginSource } from '../helpers/plugin-sources.mjs'
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'rm-content-window-'))
console.log(dir)
const flow = process.argv[2] ?? 'contentwindow'
assert(['contentwindow', 'uikit', 'theme', 'theme-parts', 'theme-libraries', 'theme-decoration', 'theme-composition', 'theme-cycle', 'theme-readers'].includes(flow), '未知的小窗验收流程')
const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), LIBRARY_PATH: join(dir, 'test.library'), CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
if (flow === 'theme') {
  const helper = resolve('artifacts/checks/theme-fixture.cjs')
  await build({ entryPoints: ['tests/electron/theme-fixture.ts'], outfile: helper,
    bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] })
  execFileSync(process.execPath, [helper, env.LIBRARY_PATH], { stdio: 'inherit' })
}
if (flow === 'theme-readers') {
  const helper = resolve('artifacts/checks/theme-readers-prepare.cjs')
  await build({ alias: { '@test-plugins/epub': pluginSource('epub') }, entryPoints: ['tests/electron/selection-prepare.ts'], outfile: helper,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['better-sqlite3'] })
  execFileSync(process.execPath, [helper, dir], { stdio: 'inherit' })
  env.LIBRARY_PATH = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8')).root
}
async function run(stage) {
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env: { ...env, CAPTURE_FLOW: stage }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const file = join(dir, stage + '.log'), log = createWriteStream(file)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timeout = setTimeout(() => {
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch {}
  }, 90000)
  const [code] = await once(child, 'close'); clearTimeout(timeout)
  await new Promise(resolve => log.end(resolve))
  assert.equal(code, 0, readFileSync(file, 'utf8'))
  assert(existsSync(join(dir, stage + '-result.json')), readFileSync(file, 'utf8'))
}

await run(flow)
if (flow === 'theme-libraries' || flow === 'theme-cycle') await run(flow + '-resume')
console.log('内容小窗验证通过：' + dir)
