// 使用独立临时新版仓库夹具，验证已删除目录的空间记录移除。
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import assert from 'node:assert/strict'
const dir = mkdtempSync(join(tmpdir(), 'rm-file-space-disposal-'))
console.log(dir)
const helper = resolve('artifacts/checks/file-space-forget-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-space-forget-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
try {
for (const flow of ['spacedisposal', 'spacedisposalresume']) {
  const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, flow + '.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
  const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
  assert.equal(code, 0, readFileSync(join(dir, flow + '.log'), 'utf8'))
  assert(existsSync(join(dir, flow + '-result.json')), readFileSync(join(dir, flow + '.log'), 'utf8'))
  assert.equal(JSON.parse(readFileSync(join(dir, flow + '-result.json'), 'utf8')).ok, true)
}
} finally {
  const stateFile = join(dir, 'disposal-state.json')
  if (process.platform === 'darwin' && existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    const source = join(homedir(), '.Trash', basename(state.bundle))
    if (existsSync(source)) {
      const manifest = JSON.parse(readFileSync(join(source, 'file-space-recovery.json'), 'utf8'))
      assert.equal(manifest.fileId, state.fileId)
      renameSync(source, join(dir, '验收结束取回的测试文件包'))
    }
  }
}
console.log('系统废纸篓物理处置、还原核验、记录清理与重启验证通过：' + dir)
