import { afterEach, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packPlugin } from '../../scripts/plugins/pack'
import { PackageManager } from '../../src/plugin-packages/manager'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { externalServices } from '../../src/main/external-services'
import { pluginLocalStore } from '../../src/main/plugin-local-store'
import { ServiceRuntime } from '../../src/main/service-runtime'
import { openLibrary } from '../../src/core/library'
import { loadExternalCore, setBinding } from '../../src/core/external-plugins'
import { PLUGINS } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { Host } from '../../src/core/host'
const roots: string[] = [], runtimes: ServiceRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.stop())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'rm-packaged-service-')); roots.push(root); return root }
const protection = { available: () => false, encrypt: () => { throw new Error() }, decrypt: () => { throw new Error() } }
function runtime(manager: PackageManager, root: string) {
  const plugins = externalServices(manager.begin(root), (plugin, signal) => pluginLocalStore({ directory: join(root, 'local'), plugin, root, active: () => !signal.aborted, protection }))
  const r = new ServiceRuntime(plugins, () => ({ library: { id: root, root }, access: {} as any, executable() { throw new Error('not exposed') } }))
  runtimes.push(r); manager.ready(root); return r
}
it('项目外打包含 service 与 UI 的包，按启用选择加载，重载后沿用配置；只提供外部服务上下文', async () => {
  const source = join(temp(), 'source'), output = join(temp(), 'demo.rmplugin')
  cpSync(resolve('examples/local-service'), source, { recursive: true }); await packPlugin(source, output)
  const archive = decodePackage(readFileSync(output))
  expect(archive.manifest.entries.service).toBe('service.mjs'); expect(archive.files.has('service.mjs')).toBe(true)
  const manager = new PackageManager(temp(), []), root = temp(), ref = manager.install(readFileSync(output))
  manager.grant(root, ref.hash)
  const a = runtime(manager, root); await a.start(new Set(['demo-service']))
  await a.invoke('demo-service', 'configure', { prefix: 'saved' })
  const values: unknown[] = []
  await a.stream('demo-service', 'echo', { text: 'abc', delay: 1 }, { signal: new AbortController().signal, emit: async v => { values.push(v) } })
  expect(values).toEqual([{ credentialReady: false }, { delta: 'saved' }, { delta: 'a' }, { delta: 'b' }, { delta: 'c' }]); await a.stop()
  const b = runtime(manager, root); await b.start(new Set(['demo-service']))
  expect(await b.invoke('demo-service', 'settings')).toMatchObject({ prefix: 'saved', runs: 1, running: 0 })
  const disabled = runtime(manager, root); await disabled.start(new Set())
  await expect(disabled.invoke('demo-service', 'settings')).rejects.toThrow('SERVICE_UNAVAILABLE')
}, 60000)
it('纯 service 包参与核心启停装配，安装和停用时不执行服务代码；导出错误只使该服务失败', async () => {
  const source = temp(), output = join(source, 'only.rmplugin')
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'only-service', title: 'only', description: 'test', author: 'test', version: '1.0.0', apiVersion: 1, entries: { service: './service.ts' } }))
  writeFileSync(join(source, 'service.ts'), "export const plugin = { id: 'only-service', start(ctx: any) { if ('access' in ctx || 'executable' in ctx) throw Error('privileged context'); return { invoke() { return 'ready' } } } }")
  await packPlugin(source, output)
  const manager = new PackageManager(temp(), PLUGINS.map(p => p.id)), ref = manager.install(readFileSync(output)), root = temp()
  manager.grant(root, ref.hash)
  const lib = openLibrary(root); setBinding(lib, { ...ref, enabled: true }, PLUGINS)
  const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, manager.begin(root))
  const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
  expect(host.plan.enabled.has('only-service')).toBe(true); host.close(); manager.ready(root)
  const r = runtime(manager, root); await r.start(new Set(['only-service']))
  expect(await r.invoke('only-service', 'read')).toBe('ready')
  const broken = decodePackage(readFileSync(output)); broken.manifest.id = 'broken-service'
  broken.files.set('service.mjs', Buffer.from("throw new Error('module evaluated')"))
  const bad = manager.install(encodePackage(broken.manifest, broken.files)); manager.grant(root, bad.hash)
  const off = runtime(manager, root); await off.start(new Set())
  expect(off.problem('broken-service')).toBeUndefined()
  const on = runtime(manager, root); await on.start(new Set(['only-service', 'broken-service']))
  expect(on.problem('broken-service')).toContain('module evaluated')
  expect(await on.invoke('only-service', 'read')).toBe('ready')
}, 60000)
