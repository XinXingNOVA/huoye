import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ecosystemEntries } from '../../src/main/ecosystem-catalog'
import { encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { PresetCatalog } from '../../src/plugin-packages/preset-catalog'
import { SuiteCatalog } from '../../src/plugin-packages/suites'
import { packageManifestSchema, type PackageManifest } from '../../src/shared/external-plugins'
import { ALL_PLUGINS } from '../../src/plugins/manifest'
import { checkExternalPackage } from '../../src/core/external-plugins'
import { openLibrary } from '../../src/core/library'
import { Registry } from '../../src/core/registry'

const folders: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'rm-ecosystem-')); folders.push(dir); return dir }
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function bytes(id: string, extra: Partial<PackageManifest> = {}, code = 'throw new Error("catalog must never execute code")') {
  return encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id, title: id, description: '', author: 'test', version: '1.0.0', entries: { core: 'core.mjs' }, ...extra }), new Map([['core.mjs', Buffer.from(code)]]))
}

it('发行升级按摘要交接新库，旧库固定原版本，第三方同名包及手动卸载的包保持原选择', () => {
  const dir = temp(), existing = temp(), fresh = temp()
  const first = new PackageManager(dir, [])
  first.provisionBundled([bytes('sample'), bytes('removed')])
  const [old, removed] = first.releasePackages()
  first.begin(existing); first.ready(existing)
  first.uninstall(removed.hash)
  const side = first.install(bytes('sample', { version: '2.1.0' }))
  const localBuild = first.install(bytes('conflict', {}, 'export const local = true'))
  const updated = new PackageManager(dir, [])
  updated.provisionBundled([bytes('sample', { version: '2.0.0' }), bytes('removed', { version: '2.0.0' }), bytes('conflict')])
  const [next, omitted, officialBuild] = updated.releasePackages()
  expect(updated.list().map(p => p.hash)).toEqual(expect.arrayContaining([old.hash, side.hash, next.hash]))
  expect(updated.list().some(p => p.hash === omitted.hash)).toBe(false)
  expect(updated.list().filter(p => p.manifest.id === 'conflict')).toEqual([localBuild])
  expect(updated.automationAllowed(localBuild.hash)).toBe(false)
  expect(updated.automationAllowed(officialBuild.hash)).toBe(true)
  expect(updated.automationAllowed(next.hash)).toBe(true)
  expect([old, side].every(p => !updated.automationAllowed(p.hash))).toBe(true)
  updated.begin(existing); updated.ready(existing); updated.begin(fresh)
  expect(updated.authorization(existing, old.hash)).toBe('granted')
  expect(updated.authorization(existing, next.hash)).toBe('approval-required')
  expect(updated.authorization(fresh, next.hash)).toBe('granted')
  expect(updated.authorization(fresh, side.hash)).toBe('approval-required')
})

it('目录发现模块、随附包和套件方案，不执行代码、不改变包授权或返回私有路径', () => {
  const dir = temp(), root = temp(), other = temp(), manager = new PackageManager(dir, ALL_PLUGINS.map(p => p.id))
  manager.provisionBundled([bytes('bundled')])
  const external = manager.install(bytes('external', { requires: ['file'] }))
  manager.grant(other, external.hash)
  manager.block(other, external.hash, '私人错误 ' + other)
  const suites = new SuiteCatalog(join(dir, 'plugin-suites.json'))
  suites.install({ hash: 'a'.repeat(64), manifest: { formatVersion: 1, id: 'starter', title: '起始套件', description: '', version: '1.0.0', packages: [], presets: [{ id: 'basic', title: '基础组合', plugins: [{ id: 'external', title: 'external' }] }] } })
  const presets = new PresetCatalog(dir)
  const before = readFileSync(join(manager.root, 'registry.json'), 'utf8')
  const global = ecosystemEntries(ALL_PLUGINS, manager, presets.list(), suites.list())
  expect(global.find(e => e.id === 'file')).toMatchObject({ source: 'builtin', required: true })
  expect(global.find(e => e.id === 'bundled')).toMatchObject({ source: 'bundled', installed: true, authorization: 'bundled-on-first-open', issues: [] })
  expect(global.find(e => e.id === 'external')).toMatchObject({ authorization: 'approval-required', requires: ['file'], issues: [] })
  expect(global.find(e => e.id === 'starter')).toMatchObject({ kind: 'suite', presets: ['suite:starter:basic'] })
  expect(global.find(e => e.id === 'suite:starter:basic')).toMatchObject({ kind: 'preset', source: 'suite', issues: [] })
  expect(global.every(e => e.runtime === 'not-checked')).toBe(true)
  expect(JSON.stringify(global)).not.toContain(dir)
  expect(JSON.stringify(global)).not.toContain(other)
  expect(ecosystemEntries(ALL_PLUGINS, manager, [], [], root).find(e => e.id === 'external')?.authorization).toBe('approval-required')
  expect(ecosystemEntries(ALL_PLUGINS, manager, [], [], other).find(e => e.id === 'external')?.authorization).toBe('blocked')
  expect(readFileSync(join(manager.root, 'registry.json'), 'utf8')).toBe(before)
})

it('静态预检分别报告依赖缺失、版本歧义、退役契约和篡改；卸载的随附包不会复装', () => {
  const dir = temp(), manager = new PackageManager(dir, ALL_PLUGINS.map(p => p.id))
  manager.provisionBundled([bytes('removed')]); const removed = manager.bundled()[0]; manager.uninstall(removed.hash)
  manager.install(bytes('missing', { requires: ['not-installed'] }))
  manager.install(bytes('choice')); manager.install(bytes('choice', { version: '2.0.0' }))
  manager.install(bytes('dependent', { requires: ['choice'] }))
  manager.install(bytes('retired', { uiFeatures: ['tool-docking-v1'] }))
  const changed = manager.install(bytes('changed'))
  writeFileSync(join(manager.directory(changed.hash), 'core.mjs'), 'changed')
  const entries = ecosystemEntries(ALL_PLUGINS, manager, [], [])
  const issues = (id: string) => entries.find(e => e.id === id)!.issues.join(';')
  expect(issues('missing')).toContain('缺少插件')
  expect(issues('dependent')).toContain('多个已安装版本')
  expect(issues('retired')).toContain('契约已退役')
  expect(issues('changed')).toContain('校验失败')
  expect(entries.find(e => e.id === 'removed')).toMatchObject({ installed: false, authorization: 'not-installed' })
  expect(manager.list().some(p => p.hash === removed.hash)).toBe(false)
})

it('外部操作分类需要兼容声明，非法分类被拒绝；旧包仍可加载且不伪装为 data', async () => {
  const manager = new PackageManager(temp(), []), lib = openLibrary(temp())
  const code = (id: string, effect?: string) => `import { z } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('zod')).href)}; export const blocks=[]; export const plugin={id:'${id}',commands:{change(){}},operations:[{name:'${id}',title:'test',description:'',${effect ? `effect:'${effect}',` : ''}command:'change',input:z.object({})}]}`
  try {
    const missing = manager.install(bytes('missing-marker', {}, code('missing-marker', 'data')))
    await expect(checkExternalPackage(lib, { ...missing, directory: manager.directory(missing.hash) }, [])).rejects.toThrow('operation-effects-v1')
    for (const [id, effect] of [['scoped', 'structure'], ['legacy', undefined], ['invalid', 'all']] as const) {
      const ref = manager.install(bytes(id, { coreFeatures: ['operation-effects-v1'] }, code(id, effect)))
      const plugin = (await checkExternalPackage(lib, { ...ref, directory: manager.directory(ref.hash) }, []))!
      if (effect === 'all') expect(() => new Registry([plugin])).toThrow('影响类别')
      else { new Registry([plugin]); expect(plugin.operations![0].effect).toBe(effect) }
    }
  } finally { lib.close() }
})
