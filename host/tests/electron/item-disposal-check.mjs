import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const dir = mkdtempSync(join(tmpdir(), 'rm-item-disposal-'))
console.log(dir)
const helper = resolve('artifacts/checks/file-space-forget-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-space-forget-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
try {
for (const flow of ['itemdisposal', 'itemdisposalresume']) {
  const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: flow }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, flow + '.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
  const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
  assert.equal(code, 0, readFileSync(join(dir, flow + '.log'), 'utf8'))
  assert(existsSync(join(dir, flow + '-result.json')), readFileSync(join(dir, flow + '.log'), 'utf8'))
}
} finally {
  // 即使核心崩溃，也只精确取回本次临时空间登记的测试包，不遍历系统废纸篓。
  if (process.platform === 'darwin' && existsSync(join(dir, 'itemdisposal-state.json'))) {
    const { roots } = JSON.parse(readFileSync(join(dir, 'itemdisposal-state.json'), 'utf8'))
    for (const root of roots) {
    const db = new Database(join(root, '.file-space.db'), { readonly: true, fileMustExist: true })
    try {
      for (const job of db.prepare('SELECT file_id,bundle FROM space_disposals').all()) {
        const source = join(homedir(), '.Trash', basename(job.bundle))
        if (!existsSync(source)) continue
        assert.equal(JSON.parse(readFileSync(join(source, 'file-space-recovery.json'), 'utf8')).fileId, job.file_id)
        renameSync(source, join(dir, '取回的测试包-' + basename(job.bundle)))
      }
    } finally { db.close() }
    }
  }
}
console.log('组合删除与重启接续验证通过：' + dir)
