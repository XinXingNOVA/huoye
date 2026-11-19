import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
const dir = resolve(process.argv[2]), userData = join(dir, 'user-data'), root = join(dir, '验收仓库.library')
const manager = new PackageManager(userData, PLUGINS.map(p => p.id)), ref = manager.install(readFileSync(process.argv[3]))
const lib = openLibrary(root)
try { manager.grant(root, ref.hash); setBinding(lib, { ...ref, enabled: true }, PLUGINS) } finally { lib.close() }
writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ root, userData }))
