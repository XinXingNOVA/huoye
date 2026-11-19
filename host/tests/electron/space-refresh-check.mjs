import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const dir = mkdtempSync(join(tmpdir(), 'rm-space-refresh-'))
console.log(dir)
const helper = resolve('artifacts/checks/file-space-forget-prepare.cjs'); mkdirSync(resolve('artifacts/checks'), { recursive: true })
await build({ entryPoints: ['tests/electron/file-space-forget-prepare.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external' })
execFileSync(process.execPath, [helper, dir], { stdio: 'inherit' })
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'))
const env = { ...process.env, LIBRARY_PATH: prepared.root, RM_USER_DATA: prepared.userData, CAPTURE_DIR: dir, CAPTURE_FLOW: 'spacerefresh' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
try {
  const child = spawn(resolve('node_modules/.bin/electron'), ['.'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(dir, 'capture.log')); child.stdout.pipe(log); child.stderr.pipe(log)
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000)
  const [code] = await once(child, 'exit'); clearTimeout(timer); log.end()
  assert.equal(code, 0, readFileSync(join(dir, 'capture.log'), 'utf8'))
  assert(existsSync(join(dir, 'spacerefresh-result.json')), readFileSync(join(dir, 'capture.log'), 'utf8'))
} finally {
  // 即使核心崩溃，也只精确取回本次临时空间登记的测试包，不遍历系统废纸篓。
  if (process.platform === 'darwin' && existsSync(join(dir, 'refresh-space.json'))) {
    const { root } = JSON.parse(readFileSync(join(dir, 'refresh-space.json'), 'utf8'))
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
console.log('文件空间处置与 PDF 刷新回归通过：' + dir)
