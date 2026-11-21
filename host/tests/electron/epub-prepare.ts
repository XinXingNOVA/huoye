import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
import { epubFixture } from '@test-plugins/epub/test/fixture'

const dir = resolve(process.argv[2]), root = join(dir, '阅读验证.library'), userData = join(dir, 'user-data')
mkdirSync(dir, { recursive: true })
const manager = new PackageManager(userData, PLUGINS.map(p => p.id))
const pack = manager.install(readFileSync(resolve('packaging/optional-plugins/epub.hyplugin')))
manager.grant(root, pack.hash)
const lib = openLibrary(root)
const catalog: { file: string; hash: string }[] = JSON.parse(readFileSync(resolve('out/main/plugins/catalog.json'), 'utf8'))
const bundled: string[] = []
try {
  for (const entry of catalog) {
    const ref = manager.install(readFileSync(resolve('out/main/plugins', entry.file)))
    if (ref.hash !== entry.hash) throw new Error('附带包摘要不匹配，请重新构建应用')
    bundled.push(ref.manifest.id)
    manager.grant(root, ref.hash)
    setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  }
  if (!bundled.includes('annotate')) throw new Error('验证需要附带的摘录批注插件')
  setBinding(lib, { ...pack, enabled: true }, PLUGINS)
} finally { lib.close() }
writeFileSync(join(dir, '山间来信.epub'), epubFixture())
writeFileSync(join(dir, 'EPUB2-无封面.epub'), epubFixture({ version: 2, cover: false }))
writeFileSync(join(dir, '固定版式.epub'), epubFixture({ fixed: true }))
writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ root, userData, hash: pack.hash, bundled }))
