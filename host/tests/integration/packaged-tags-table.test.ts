import { pluginSource } from '../helpers/plugin-sources'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packPlugin } from '../../scripts/plugins/pack'
import { readDistribution, validateDistribution } from '../../scripts/plugins/distribution'
import { decodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { adoptBundledPlugins, checkPackageKinds, checkPackageOwnership, loadExternalCore, readBindings, readDisabled } from '../../src/core/external-plugins'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { PLUGINS } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import { blocks } from '../fixtures/legacy-tags/blocks'
import { seedTagsTable } from '../fixtures/tags-table-fixture'
import { tempDir } from '../helpers/helpers'

const roots: string[] = [], hosts: Host[] = []
const temp = () => { const dir = tempDir('rm-tags-table-'); roots.push(dir); return dir }
let bytes: Buffer[], build: string
beforeAll(async () => {
  build = tempDir('rm-tags-table-packs-')
  bytes = await Promise.all(['tags', 'table', 'fields'].map(async id => {
    const dir = join(build, id)
    cpSync(pluginSource(id), dir, { recursive: true })
    await packPlugin(dir, join(build, `${id}.rmplugin`))
    rmSync(dir, { recursive: true }) // 加载时不能再借源目录依赖。
    return readFileSync(join(build, `${id}.rmplugin`))
  }))
}, 60000)
afterAll(() => rmSync(build, { recursive: true, force: true }))
afterEach(() => { hosts.splice(0).forEach(h => { if (h.lib.db.open) h.close() }); roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const manager = (user = temp()) => { const m = new PackageManager(user, PLUGINS.map(p => p.id)); m.provisionBundled(bytes); return m }
async function start(root: string, m: PackageManager) {
  const lib = openLibrary(root)
  try {
    adoptBundledPlugins(lib, m.bundled(), PLUGINS, DISTRIBUTION)
    const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, m.begin(root), DISTRIBUTION)
    const h = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
    hosts.push(h); m.ready(root); await h.scheduler.idle(); return h
  } catch (e) { if (lib.db.open) lib.close(); throw e }
}

it('独立目录打包并捆入普通 JS 依赖与专用样式，生产装配不再静态导入业务', () => {
  expect(PLUGINS.some(p => ['tags','table'].includes(p.id))).toBe(false)
  for (const buffer of bytes.slice(0,2)) {
    const p = decodePackage(buffer)
    expect(p.manifest.styles).toEqual(['ui.css'])
    expect(p.files.get('ui.css')!.toString()).toContain(p.manifest.id === 'tags' ? '.tag-input' : '.table-row')
    expect(p.files.get('ui.mjs')!.toString()).toContain('__rmPluginSdk')
    expect(p.manifest).not.toHaveProperty('legacyKinds')
  }
})

it.each([false,true].flatMap(registered => [[],['tags'],['table'],['tags','table']].map(disabled => ({ registered, disabled }))))('旧库 $registered / $disabled：保留选择、标签、分组 ID、模板与表格视图；旧会话历史清理', async ({ registered, disabled }) => {
  const root = temp(), before = await seedTagsTable(root, disabled, registered), m = manager(), h = await start(root, m)
  expect(h.store.get(before.ids)).toEqual(before.records)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
  for (const id of ['tags','table']) expect(h.plan.enabled.has(id), id).toBe(!disabled.includes(id))
  expect(h.plan.enabled.has('fields')).toBe(true)
  expect((await h.api.query({ where: [{ op: 'eq', kind: 'tags', field: 'values', value: '光影' }] })).ids).toEqual([before.id])
  const config = h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
  adoptBundledPlugins(h.lib, m.bundled(), PLUGINS, DISTRIBUTION)
  expect(h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(config)
})

it('标签基础操作与回执、撤销；旧分组只读保留，停用卸载后重装恢复', async () => {
  const root = temp(), user = temp(), before = await seedTagsTable(root), m = manager(user)
  let h = await start(root, m)
  expect((await h.api.describeLibrary()).operations.map(o => o.name)).toContain('update_tags')
  const request = { operation: 'update_tags', requestId: 'packaged-tags-update', args: { ids: [before.id], add: ['新增'], remove: ['光影'] } }
  const result = await h.api.executeOperation(request)
  expect(h.store.blocksOf(before.id).tags.data.values).toEqual(['保留','新增'])
  expect(await h.api.executeOperation(request)).toEqual({ ...result, replayed: true })
  h.api.undo(); expect(h.store.blocksOf(before.id).tags.data.values).toEqual(['光影','保留'])
  expect(() => h.api.executeOperation({ ...request, requestId: 'management-protected', args: { ids: [before.groups], add: ['不应添加'] } })).toThrow()
  expect((await h.api.describeLibrary()).operations.map(o => o.name)).not.toContain('create_group')
  // 分组已移交独立插件；本测试保留旧备份，首写接续由 tag-collaboration 覆盖。
  expect(h.store.blocksOf(before.groups).tagGroups.data).toEqual(before.records[1].blocks.tagGroups.data)
  const data = h.store.get(before.ids), refs = readBindings(h.lib).filter(p => ['tags','table'].includes(p.manifest.id))
  h.api.setPluginSettings(readDisabled(h.lib), refs.map(p => ({ ...p, enabled: false }))); h.close()
  refs.forEach(p => m.uninstall(p.hash))
  const restarted = manager(user); h = await start(root, restarted)
  expect(restarted.list().map(p => p.manifest.id)).toEqual(['fields'])
  expect(h.store.get(before.ids)).toEqual(data)
  expect(h.reg.kind('tagGroups')?.dormant).toBe(true)
  expect((await h.api.describeLibrary()).operations.map(o => o.name)).not.toContain('update_tags')
  expect(() => h.api.patch(before.id, 'tags', { values: [] })).toThrow('没有启用')
  expect((await h.api.query({ text: '光影' })).ids).toContain(before.id)
  expect(h.plan.enabled.has('fields')).toBe(true)
  bytes.forEach(b => restarted.install(b)); h.close(); h = await start(root, restarted)
  expect(h.plan.enabled.has('tags')).toBe(false)
  refs.forEach(p => restarted.grant(root, p.hash))
  h.api.setPluginSettings(readDisabled(h.lib), refs.map(p => ({ ...p, enabled: true }))); h.close(); h = await start(root, restarted)
  expect(h.store.get(before.ids)).toEqual(data)
  expect((await h.api.executeOperation(request)).replayed).toBe(true)
  h.api.run('tags', 'update', { ids: [before.id], add: ['重装后标签'] })
  expect(h.store.blocksOf(before.id).tags.data.values).toContain('重装后标签')
  expect(h.store.blocksOf(before.groups).tagGroups.data).toEqual(before.records[1].blocks.tagGroups.data)
})

it('旧 ID 例外仅由应用声明，拒绝普通包抢占与持久定义变更', async () => {
  expect(() => checkPackageOwnership('tags', blocks, [])).toThrow('tagGroups')
  expect(() => checkPackageOwnership('tags', blocks, DISTRIBUTION)).not.toThrow()
  const old = blocks.find(k => k.id === 'tagGroups')!
  expect(() => checkPackageOwnership('tag', [{ ...old, plugin: 'tag' }], DISTRIBUTION)).toThrow('tagGroups')
  expect(() => checkPackageOwnership('tags', [{ ...old, id: 'foreign' }], DISTRIBUTION)).toThrow('foreign')
  const policy = DISTRIBUTION.find(p => p.id === 'tags')!
  expect(() => validateDistribution([...DISTRIBUTION, { ...policy, id: 'other' }])).toThrow('归属冲突')
  const dir = temp(); writeFileSync(join(dir, 'distribution.json'), JSON.stringify({ group: 'common', defaultEnabled: true, legacyKinds: ['tagGroups'] }))
  expect(() => readDistribution(dir, { id: 'test', title: '', description: '' }, 'bundled')).toThrow('发行策略无效')
  const root = temp(); await seedTagsTable(root)
  const lib = openLibrary(root)
  try { expect(() => checkPackageKinds(lib, 'tags', blocks.map(k => k.id === 'tagGroups' ? { ...k, version: 2 } : k))).toThrow('不兼容') } finally { lib.close() }
})

it.skipIf(!process.env.TAGS_TABLE_LEGACY_DIR)('生成 Electron 标签表格旧库及旧工作区', async () => {
  const dir = resolve(process.env.TAGS_TABLE_LEGACY_DIR!)
  mkdirSync(join(dir, 'user/workspaces'), { recursive: true })
  const fixture = await seedTagsTable(join(dir, 'library'), [], true)
  const disabled = await seedTagsTable(join(dir, 'disabled-library'), ['tags','table'], true)
  writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ ...fixture, disabled }))
  writeFileSync(join(dir, 'user/workspaces', `${fixture.libraryId}.json`), JSON.stringify(fixture.workspace))
})
