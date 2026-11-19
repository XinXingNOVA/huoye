import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url), dir = mkdtempSync(join(tmpdir(), 'rm-visual-ai-'))
// --roles 单独验证建库授权、素材与容器、检查器；完整的窗口焦点与重启验收仍按默认两阶段运行。
const args = process.argv.slice(2), rolesOnly = args[0] === '--roles'
const reviewOnly = args[0] === '--review', inventoryOnly = args[0] === '--inventory'
if (rolesOnly || reviewOnly || inventoryOnly) args.shift()
if (reviewOnly) {
  const { packPlugin } = await import('../../scripts/plugins/pack.ts')
  await packPlugin('tests/fixtures/review-sample', join(dir, 'sample.rmplugin'))
}
console.log(dir)
const entry = resolve('out/main/visual-ai-check.cjs')
await build({ entryPoints: ['tests/electron/visual-ai-main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
for (const phase of inventoryOnly ? ['inventory'] : reviewOnly ? ['review', 'review-resume'] : rolesOnly ? ['roles'] : ['first', 'resume']) {
  const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), VISUAL_AI_DIR: dir, VISUAL_AI_PHASE: phase,
    VISUAL_AI_SUITE: resolve(args[0] ?? 'artifacts/suites/visual-library/visual-library-0.3.0.rmsuite'),
    VISUAL_AI_FIELDS: resolve(args[1] ?? 'artifacts/plugins/fields.hyplugin'), VISUAL_AI_TREE: resolve(args[2] ?? '../plugins/tag-tree/artifacts/tag-tree.rmplugin') }
  for (const key of ['LIBRARY_PATH', 'CAPTURE_DIR', 'CAPTURE_FLOW', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key]
  const child = spawn(require('electron'), [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const file = join(dir, phase + '.log'), log = createWriteStream(file)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => child.kill('SIGKILL'), inventoryOnly ? 300000 : 150000)
  const [code] = await once(child, 'close'); clearTimeout(timer); await new Promise(r => log.end(r))
  assert.equal(code, 0, readFileSync(file, 'utf8'))
  assert(existsSync(join(dir, phase + '-result.json')), readFileSync(file, 'utf8'))
  console.log(readFileSync(join(dir, phase + '-result.json'), 'utf8'))
}
console.log((inventoryOnly ? '大库 MCP 盘点通过：' : reviewOnly ? '通用批次验收与跨会话补单通过：' : rolesOnly ? '视觉素材库授权、容器与检查器通过：' : '视觉素材库 AI 建库、整理、工作台交付与重启通过：') + dir)
