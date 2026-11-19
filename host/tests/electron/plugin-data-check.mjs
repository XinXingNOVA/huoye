// 包、仓库和应用配置全部临时；可用 RM_LIFECYCLE_PACKAGES_FILE 额外验证独立插件包。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'rm-plugin-data-'))
console.log(dir)
for (const flow of ['plugindata']) {
  const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), LIBRARY_PATH: join(dir, 'test.library'), CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const file = join(dir, flow + '.log'), log = createWriteStream(file)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timeout = setTimeout(() => {
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch {}
  }, 180000)
  const [code] = await once(child, 'close'); clearTimeout(timeout)
  await new Promise(resolve => log.end(resolve))
  assert.equal(code, 0, readFileSync(file, 'utf8'))
  assert(existsSync(join(dir, flow + '-result.json')), readFileSync(file, 'utf8'))
}
console.log('插件生命周期验证通过：' + dir)
