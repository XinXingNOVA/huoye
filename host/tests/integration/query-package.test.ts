import { afterEach, beforeAll, expect, it } from 'vitest'
import { cpSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packPlugin } from '../../scripts/plugins/pack'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { loadExternalCore, setBinding } from '../../src/core/external-plugins'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { tempDir } from '../helpers/helpers'

let bytes: Buffer
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(f => f()))
const temp = () => { const p = tempDir(); cleanups.push(() => rmSync(p, { recursive: true, force: true })); return p }
beforeAll(async () => {
  const dir = tempDir()
  try {
    cpSync(resolve('examples/query-plugin'), join(dir, 'source'), { recursive: true })
    await packPlugin(join(dir, 'source'), join(dir, 'example.rmplugin'))
    bytes = readFileSync(join(dir, 'example.rmplugin'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 60000)

it('外部纯查询包独立打包、安装、装配、发现、调用和停用，不需要宿主业务分支', async () => {
  const root = temp(), manager = new PackageManager(temp(), PLUGINS.map(p => p.id))
  const ref = manager.install(bytes); manager.grant(root, ref.hash)
  const lib = openLibrary(root); cleanups.push(() => { if (lib.db.open) lib.close() })
  setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, manager.begin(root))
  expect(assembly.manifest.find(p => p.id === 'demo-query')?.problem).toBeUndefined()
  const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
  cleanups.push(() => host.close()); manager.ready(root)
  expect((await host.api.describeLibrary()).queries.map(q => q.name)).toEqual(['demo-query.overview', 'demo-query.file_formats'])
  expect((await host.api.executeQuery({ query: 'demo-query.overview' })).result).toEqual({ materials: 0, files: 0 })
  expect((await host.api.executeQuery({ query: 'demo-query.file_formats', limit: 1 })).result).toEqual({ items: [], total: 0, nextCursor: null })
  setBinding(lib, { ...ref, enabled: false }, PLUGINS)
  const disabled = await loadExternalCore(lib, PLUGINS, corePlugins, manager.begin(root))
  expect(disabled.plugins.some(p => p.id === 'demo-query')).toBe(false)
})
it('声明 queries 必须声明宿主能力；未知能力在安装前拒绝', async () => {
  const pack = decodePackage(bytes), root = temp(), manager = new PackageManager(temp(), [])
  expect(() => encodePackage({ ...pack.manifest, coreFeatures: ['future-query-version'] as never }, pack.files)).toThrow()
  const ref = manager.install(encodePackage({ ...pack.manifest, coreFeatures: [] }, pack.files))
  manager.grant(root, ref.hash)
  const lib = openLibrary(root); cleanups.push(() => lib.close())
  setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, manager.begin(root))
  expect(assembly.manifest.find(p => p.id === 'demo-query')?.problem).toContain('business-queries-v1')
  expect(assembly.plugins.some(p => p.id === 'demo-query')).toBe(false)
})
