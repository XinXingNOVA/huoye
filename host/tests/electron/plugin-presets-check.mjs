// 基础构建；包、仓库、应用配置全部临时，不依赖业务插件工程。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'rm-plugin-presets-'))
console.log(dir)
for (const flow of process.argv.includes('--suites') ? ['pluginsuites', 'pluginsuitesresume'] : ['pluginpresets', 'pluginpresetsother', 'pluginpresetsresume']) {
  const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), LIBRARY_PATH: join(dir, flow === 'pluginpresetsother' ? 'other.library' : 'test.library'), CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const file = join(dir, flow + '.log'), log = createWriteStream(file)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timeout = setTimeout(() => {
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch {}
  }, 90000)
  const [code] = await once(child, 'close'); clearTimeout(timeout)
  await new Promise(resolve => log.end(resolve))
  assert.equal(code, 0, readFileSync(file, 'utf8'))
  assert(existsSync(join(dir, flow + '-result.json')), readFileSync(file, 'utf8'))
}
console.log((process.argv.includes('--suites') ? '套件安装、直达预览、布局接续、免重载、副本及重启通过：' : '插件组合保存、预演、统一应用、缺包／过期预览、跨库与重启通过：') + dir)
