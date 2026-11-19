import { pluginSource } from '../helpers/plugin-sources'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { packPlugin } from '../../scripts/plugins/pack'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { readBundledPackages } from '../../src/plugin-packages/bundled'
import { adoptBundledPlugins, loadExternalCore, readBindings, readDisabled, setBinding } from '../../src/core/external-plugins'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { PLUGINS } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { seedLegacyPackages } from '../fixtures/packaged-fixture'

const folders: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'rm-bundled-test-')); folders.push(dir); return dir }
const hosts: Host[] = []
let bytes: Buffer[], build: string
beforeAll(async () => {
  build = mkdtempSync(join(tmpdir(), 'rm-bundled-build-'))
  bytes = await Promise.all(['status', 'kanban'].map(async id => {
    cpSync(pluginSource(id), join(build, id), { recursive: true })
    await packPlugin(join(build, id), join(build, `${id}.${id === 'status' ? 'hyplugin' : 'rmplugin'}`))
    return readFileSync(join(build, `${id}.${id === 'status' ? 'hyplugin' : 'rmplugin'}`))
  }))
}, 60000)
afterAll(() => rmSync(build, { recursive: true, force: true }))
afterEach(() => {
  hosts.splice(0).forEach(h => { if (h.lib.db.open) h.close() })
  folders.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})
const manager = (user = temp()) => { const m = new PackageManager(user, PLUGINS.map(p => p.id)); m.provisionBundled(bytes); return m }
async function start(root: string, m: PackageManager) {
  const lib = openLibrary(root)
  try {
    adoptBundledPlugins(lib, m.bundled(), PLUGINS)
    const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, m.begin(root))
    const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
    m.ready(root); hosts.push(host); return host
  } catch (e) { if (lib.db.open) lib.close(); throw e }
}

describe('状态和看板从内置迁成安装包', () => {
  it('源码可在项目外打包，样式随包；生产清单不静态装配这两个插件', () => {
    expect(PLUGINS.some(p => ['status', 'kanban'].includes(p.id))).toBe(false)
    for (const buffer of bytes) {
      const p = decodePackage(buffer)
      expect(p.manifest.styles).toEqual(['ui.css'])
      expect(p.files.get('ui.css')!.toString()).toContain(`.${p.manifest.id}`)
      expect(p.files.get('ui.mjs')!.toString()).toContain('__rmPluginSdk')
    }
    writeFileSync(join(build, 'catalog.json'), JSON.stringify(bytes.map(b => { const p = decodePackage(b); return { file: `${p.manifest.id}.${p.manifest.id === 'status' ? 'hyplugin' : 'rmplugin'}`, hash: p.hash } })))
    expect(readBundledPackages(build)).toEqual(bytes)
    writeFileSync(join(build, 'catalog.json'), JSON.stringify([{ file: '../status.rmplugin', hash: 'bad' }]))
    expect(() => readBundledPackages(build)).toThrow('路径')
  })
  it.each([[], ['status'], ['kanban'], ['status', 'kanban', 'preview']].map(disabled => ({ disabled })))('旧启停 $disabled：接续配置、数据版本、历史及看板，重复交接不重写', async ({ disabled }) => {
    const root = temp(), before = await seedLegacyPackages(root, disabled), m = manager()
    const host = await start(root, m)
    expect(host.store.get([before.id, before.viewId])).toEqual(before.records)
    expect(host.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
    for (const id of ['status', 'kanban']) {
      expect(host.plan.enabled.has(id)).toBe(!disabled.includes(id))
      expect(readBindings(host.lib).find(b => b.manifest.id === id)?.enabled).toBe(!disabled.includes(id))
    }
    expect(readDisabled(host.lib)).toEqual(disabled.filter(id => !['status', 'kanban'].includes(id)))
    const config = host.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
    adoptBundledPlugins(host.lib, m.bundled(), PLUGINS)
    expect(host.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(config)
    expect((await host.api.query({ where: [{ op: 'eq', kind: 'status', field: 'value', value: '进行中' }] })).ids).toEqual([before.id])
  })
  it('首次关闭的状态可明确重启；停用卸载后不自动装回，重装后恢复编辑和撤销', async () => {
    const root = temp(), user = temp(), before = await seedLegacyPackages(root, ['status']), m = manager(user)
    let host = await start(root, m)
    const status = m.bundled().find(p => p.manifest.id === 'status')!
    expect(host.reg.kind('status')?.dormant).toBe(true)
    await host.api.setExternalPlugin({ ...status, enabled: true }); host.close()
    host = await start(root, m)
    await host.api.patch(before.id, 'status', { value: '已完成' }); await host.api.undo()
    expect(host.store.blocksOf(before.id).status.data.value).toBe('进行中')
    await host.api.setExternalPlugin({ ...status, enabled: false }); host.close()
    m.uninstall(status.hash)
    const restarted = manager(user)
    expect(restarted.list().some(p => p.hash === status.hash)).toBe(false)
    host = await start(root, restarted)
    expect(host.reg.kind('status')?.dormant).toBe(true)
    expect(() => host.api.patch(before.id, 'status', { value: '已完成' })).toThrow('没有启用')
    expect(host.store.get([before.viewId])).toEqual(before.records.filter(r => r.id === before.viewId))
    restarted.install(bytes[0])
    host.close(); host = await start(root, restarted)
    expect(host.plan.enabled.has('status')).toBe(false) // 仅重装不启用、不重新授权
    restarted.grant(root, status.hash)
    await host.api.setExternalPlugin({ ...status, enabled: true }); host.close()
    host = await start(root, restarted)
    expect(host.reg.kind('status')?.dormant).toBeUndefined()
    expect(host.store.blocksOf(before.id).status.data.value).toBe('进行中')
  })
  it('已有外部选择优先；非应用交付的版本不能借同一 ID 自动授权', async () => {
    const root = temp(), before = await seedLegacyPackages(root, ['status']), m = manager()
    const pack = decodePackage(bytes[0])
    const other = m.install(encodePackage({ ...pack.manifest, version: '2.0.0' }, pack.files))
    const lib = openLibrary(root)
    setBinding(lib, { ...other, enabled: true }, PLUGINS); lib.close()
    const host = await start(root, m)
    expect(readBindings(host.lib).find(p => p.manifest.id === 'status')).toEqual({ ...other, enabled: true })
    expect(host.plan.enabled.has('status')).toBe(false)
    expect(host.plan.off.get('status')).toContain('尚未')
    expect(host.store.blocksOf(before.id).status.data.value).toBe('进行中')
  })
  it('已有同版本不同内容不会被覆盖或阻止交接；启动失败隔离不会被自动授权清除', () => {
    const user = temp(), root = temp(), m = new PackageManager(user, [])
    const p = decodePackage(bytes[0]); p.files.set('extra.txt', Buffer.from('用户版本'))
    const manual = m.install(encodePackage(p.manifest, p.files))
    m.provisionBundled(bytes)
    expect(m.list().filter(p => p.manifest.id === 'status')).toEqual([manual])
    expect(m.begin(root).find(p => p.hash === manual.hash)?.problem).toContain('尚未')
    m.ready(root)
    const kanban = m.bundled().find(p => p.manifest.id === 'kanban')!
    m.block(root, kanban.hash, '用户版本出错')
    expect(m.begin(root).find(p => p.hash === kanban.hash)?.problem).toBe('用户版本出错')
    m.ready(root)
  })
})

it.skipIf(!process.env.PACKAGED_LEGACY_DIR)('生成隔离 Electron 旧库样本', async () => {
  const dir = resolve(process.env.PACKAGED_LEGACY_DIR!)
  const fixture = await seedLegacyPackages(join(dir, 'library'))
  const disabled = await seedLegacyPackages(join(dir, 'disabled-library'), ['status', 'kanban'])
  const workspaces = join(dir, 'user', 'workspaces'); mkdirSync(workspaces, { recursive: true })
  writeFileSync(join(workspaces, `${fixture.libraryId}.json`), JSON.stringify(fixture.workspace))
  writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ ...fixture, disabled }))
})
