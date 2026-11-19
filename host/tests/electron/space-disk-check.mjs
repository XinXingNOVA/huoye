import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const dir = mkdtempSync(join(tmpdir(), 'rm-space-disk-'))
console.log(dir)
const helper = resolve('artifacts/checks/space-disk-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-space-forget-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
for (const flow of ['spacedisk', 'spacediskresume']) {
  const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, `${flow}.log`)); child.stdout.pipe(log); child.stderr.pipe(log)
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
  const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
  assert.equal(code, 0, readFileSync(join(dir, `${flow}.log`), 'utf8'))
  assert(existsSync(join(dir, `${flow}-result.json`)), readFileSync(join(dir, `${flow}.log`), 'utf8'))
}
console.log('磁盘检查、确认、接纳、重新定位及重启验证通过：' + dir)
