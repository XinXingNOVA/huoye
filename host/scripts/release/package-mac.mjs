// 部分开发检出共享 node_modules。npm list 在整目录为符号链接时会漏报传递依赖。
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const modules = join(root, 'node_modules')
const args = ['--config', 'electron-builder.config.cjs', '--mac', ...process.argv.slice(2), '--publish', 'never']
let staging
try {
  if ((await lstat(modules)).isSymbolicLink()) {
    staging = await mkdtemp(join(tmpdir(), 'huoye-package-'))
    const copyOptions = { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE }
    for (const name of ['out', 'package.json', 'package-lock.json']) {
      await cp(join(root, name), join(staging, name), copyOptions)
    }
    await cp(await realpath(modules), join(staging, 'node_modules'), copyOptions)
    args.push(`--config.directories.app=${staging}`)
  }
  const result = spawnSync(process.execPath, [join(modules, 'electron-builder/cli.js'), ...args], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (staging) await rm(staging, { recursive: true, force: true })
}
