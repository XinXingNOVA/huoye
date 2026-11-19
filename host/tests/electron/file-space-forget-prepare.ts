import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Host } from '../../src/core/host'
import { filePlugin } from '../../src/plugins/file/core'
import { textPlugin } from '../../src/plugins/text/core'
import { PackageManager } from '../../src/plugin-packages/manager'
import { setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
async function prepare() {
  const dir = resolve(process.argv[2]), root = join(dir, '空间记录验收.library'), userData = join(dir, 'user-data')
  mkdirSync(root, { recursive: true })
  const original = '# 验收文字\n\n保留身份与原件。', path = join(dir, '测试文档.md')
  writeFileSync(path, original)
  const host = new Host(root, [filePlugin, textPlugin], () => {})
  try {
    const [id] = await host.api.ingest([{ type: 'file', path }]); await host.scheduler.idle()
    const manager = new PackageManager(userData, PLUGINS.map(p => p.id))
    const catalog: { file: string }[] = JSON.parse(readFileSync(resolve('out/main/plugins/catalog.json'), 'utf8'))
    const files = [...catalog.map(item => resolve('out/main/plugins', item.file)), ...process.argv.slice(3)]
    for (const file of files) {
      const ref = manager.install(readFileSync(file))
      manager.grant(root, ref.hash); setBinding(host.lib, { ...ref, enabled: true }, PLUGINS)
    }
    writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ root, userData, id, original }))
  } finally { host.close() }
}
void prepare().catch(e => { console.error(e); process.exitCode = 1 })
