import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, createWriteStream, mkdtempSync, readFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url), dir = realpathSync(mkdtempSync(join(tmpdir(), 'rm-development-ai-')))
console.log(dir)
cpSync('examples/local-plugin', join(dir, 'source'), { recursive: true })
// 公共设置生命周期契约的故障夹具；仅修改临时复制，不改示例或宿主业务插件。
const ui = join(dir, 'source', 'ui.tsx')
writeFileSync(ui, readFileSync(ui, 'utf8').replace("import { useState }", "import { useEffect, useRef, useState }")
  .replace('  const kinds = useKinds()', `  const kinds = useKinds()
  const blocked = useRef(false)
  useEffect(() => host.settings.registerGuard('demo-reviewmemo.fixture', {
    state: () => ({ dirty: blocked.current, message: '验收夹具：页面尚未保存' }),
    beforeLeave: () => !blocked.current
  }), [host.settings])`)
  .replace('<p>数据定义：', '<label><input type="checkbox" aria-label="模拟未保存页面" onChange={e => { blocked.current = e.target.checked }} />模拟未保存页面</label><p>数据定义：'))
const entry = resolve('out/main/development-ai-check.cjs')
await build({ entryPoints: ['tests/electron/development-ai-main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
for (const phase of ['first', 'resume']) {
  const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), DEVELOPMENT_AI_DIR: dir, DEVELOPMENT_AI_PHASE: phase, DEVELOPMENT_AI_TOOLCHAIN: resolve('.'), CAPTURE_DIR: dir }
  for (const key of ['LIBRARY_PATH', 'CAPTURE_FLOW', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key]
  const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const file = join(dir, phase + '.log'), log = createWriteStream(file)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
  const [code] = await once(child, 'close'); clearTimeout(timer); await new Promise(r => log.end(r))
  assert.equal(code, 0, readFileSync(file, 'utf8'))
  assert(existsSync(join(dir, phase + '-result.json')), readFileSync(file, 'utf8'))
  console.log(readFileSync(join(dir, phase + '-result.json'), 'utf8'))
}
console.log('开发验收 MCP、生命周期与重启验证通过：' + dir)
