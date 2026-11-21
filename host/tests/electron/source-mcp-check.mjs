import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

// npm run build 后运行。复用空间盘点的样本，确保附件仍可在插件停用时受到保护。
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'huoye-source-mcp-')))
console.log(dir)
const helper = resolve('artifacts/checks/source-mcp-prepare.cjs')
await build({ entryPoints: ['tests/electron/space-items-prepare.ts'], outfile: helper,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir], { stdio: 'inherit' })
const env = { ...process.env, RM_USER_DATA: join(dir, 'user-data'), LIBRARY_PATH: join(dir, 'sample.library'), CAPTURE_DIR: dir, CAPTURE_FLOW: 'sourcemcp' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
execFileSync(electron, ['.'], { env, stdio: 'inherit', timeout: 180000 })
const result = JSON.parse(readFileSync(join(dir, 'source-mcp-result.json'), 'utf8'))
assert.equal(result.ok, true)
console.log('文件空间 MCP 双库验收通过', result)
