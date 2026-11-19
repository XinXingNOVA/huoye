// 使用独立临时新版仓库夹具，验证已删除目录的空间记录移除。
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const dir = mkdtempSync(join(tmpdir(), 'rm-file-space-forget-'))
console.log(dir)
const helper = resolve('artifacts/checks/file-space-forget-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-space-forget-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir, resolve('artifacts/plugins/note.hyplugin')], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
for (const flow of ['spaceforget', 'spaceforgetresume']) {
  const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, flow + '.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000)
  const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
  assert.equal(code, 0, readFileSync(join(dir, flow + '.log'), 'utf8'))
  assert.equal(JSON.parse(readFileSync(join(dir, flow + '-result.json'), 'utf8')).ok, true)
}
console.log('空间记录移除、原生导入与重启验证通过：' + dir)
