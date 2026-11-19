// 两轮共用临时仓库与独立的 RM_USER_DATA，分别验证真实导入窗口和重启后的回执。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, createWriteStream, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rm-import-settings-')))
const entry = resolve('out/main/import-settings-check.cjs')
console.log(dir)
await build({
  entryPoints: ['tests/electron/import-settings-main.mjs'],
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
})
for (const phase of ['first', 'resume']) {
  const env = {
    ...process.env,
    RM_USER_DATA: join(dir, 'user-data'),
    LIBRARY_PATH: join(dir, 'test.library'),
    IMPORT_SETTINGS_TEST: dir,
    IMPORT_PHASE: phase,
  }
  for (const key of ['CAPTURE_DIR', 'CAPTURE_FLOW', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key]
  const child = spawn(resolve('node_modules/.bin/electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const file = join(dir, phase + '.log'),
    log = createWriteStream(file)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
  const [code] = await once(child, 'close')
  clearTimeout(timer)
  await new Promise((r) => log.end(r))
  assert.equal(code, 0, readFileSync(file, 'utf8'))
  assert(JSON.parse(readFileSync(join(dir, phase + '-result.json'), 'utf8')).ok)
}
console.log('导入规则、单次导入回执、未收录筛选、手动收录和重启验证通过')
