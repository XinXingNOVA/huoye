import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
let toolchain = process.env.RM_PLUGIN_TOOLCHAIN
if (!toolchain) {
  try { toolchain = JSON.parse(readFileSync(resolve(root, '.rm-dev.json'), 'utf8')).toolchain }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
if (!toolchain) throw new Error('设置 RM_PLUGIN_TOOLCHAIN 或 .rm-dev.json 的 toolchain，指向已安装依赖的宿主工程')
const result = spawnSync(process.execPath, [resolve(root, toolchain, 'scripts/plugins/project.ts'), process.argv[2] ?? 'check', root], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
