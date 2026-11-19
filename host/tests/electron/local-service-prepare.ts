import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
const dir = resolve(process.argv[2]), userData = join(dir, 'user-data'), root = join(dir, '服务体验.library'), other = join(dir, '另一服务库.library')
mkdirSync(dir, { recursive: true })
const manager = new PackageManager(userData, PLUGINS.map(p => p.id)), ref = manager.install(readFileSync(process.argv[3]))
for (const path of [root, other]) {
  const lib = openLibrary(path)
  try { manager.grant(path, ref.hash); setBinding(lib, { ...ref, enabled: true }, PLUGINS) } finally { lib.close() }
}
writeFileSync(join(dir, '新服务验证.txt'), '服务框架更新后，新文件收录和正文加工仍正常。')
writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ root, other, userData, ref }))
