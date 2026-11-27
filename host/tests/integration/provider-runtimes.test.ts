import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { providerRuntime } from '../../src/core/provider-programs'
import { encodePackage, isPluginResource } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { runtimePath, runtimeTargets, type RuntimeTarget } from '../../src/shared/provider-runtimes'

const capability = 'media.inspect@1'
const program = 'image-info'
const manifest = (targets: RuntimeTarget[]) => packageManifestSchema.parse({
  formatVersion: 1, apiVersion: 1, id: 'image-engine', title: 'Image engine', author: 'test', description: '', version: '1.0.0',
  entries: { provider: 'provider.mjs' }, capabilities: { version: 2, provides: [capability], runtimes: [{ program, targets }],
    implementations: [{ id: capability, execution: 'local', programs: [program] }] }
})

it('包只接受清单逐项声明的程序与目标，按平台检查后缀、文件和重复项', () => {
  const windows = manifest(['win32-x64'])
  const files = new Map([['provider.mjs', Buffer.from('test')]])
  const path = runtimePath(program, 'win32-x64')
  expect(path).toBe('runtimes/win32-x64/image-info.exe')
  expect(isPluginResource(path)).toBe(false)
  expect(isPluginResource('package.rmplugin')).toBe(false)
  expect(isPluginResource('assets/cover.png')).toBe(true)
  expect(() => encodePackage(windows, files)).toThrow('不存在或为空')
  files.set(path, Buffer.alloc(0))
  expect(() => encodePackage(windows, files)).toThrow('不存在或为空')
  files.set(path, Buffer.from('windows fixture'))
  expect(() => encodePackage(windows, files)).not.toThrow()
  for (const extra of ['assets/extra.exe', 'runtimes/win32-x64/extra.exe', 'RUNTIMES/hidden.json']) {
    expect(() => encodePackage(windows, new Map([...files, [extra, Buffer.from('extra')]]))).toThrow()
  }
  const legacy = { ...windows, capabilities: undefined, entries: { ui: 'ui.mjs' as const } }
  expect(() => encodePackage(legacy, new Map([['ui.mjs', Buffer.from('test')], ['runtimes/labels.json', Buffer.from('{}')]]))).not.toThrow()
  const caps = windows.capabilities!
  for (const declaration of [
    { version: 1 }, { runtimes: [{ program: 'other', targets: ['win32-x64'] }] },
    { runtimes: [{ program, targets: ['win32-x64', 'win32-x64'] }] },
    { runtimes: [...caps.runtimes!, ...caps.runtimes!] },
    { runtimes: [{ program: '../elsewhere', targets: ['linux-arm64'] }] }
  ]) expect(packageManifestSchema.safeParse({ ...windows, capabilities: { ...caps, ...declaration } }).success).toBe(false)
  expect(packageManifestSchema.safeParse({ ...windows, entries: { core: 'core.mjs' } }).success).toBe(false)
})

it('安装后只解析本机版本，其他架构和损坏的随包程序即使有同名系统程序也不可用', () => {
  const current = runtimeTargets.find(t => t === process.platform + '-' + process.arch)!
  const other = runtimeTargets.find(t => t !== current)!
  const base = mkdtempSync(join(tmpdir(), 'huoye-engine-'))
  try {
    const manager = new PackageManager(base, [])
    const meta = manifest([current, other])
    const local = runtimePath(program, current), foreign = runtimePath(program, other)
    const files = new Map([['provider.mjs', Buffer.from('test')], [local, Buffer.from('native')], [foreign, Buffer.from('other')]])
    const ref = manager.install(encodePackage(meta, files))
    manager.grant(base, ref.hash)
    const [installed] = manager.available(base)
    const binary = join(installed.directory, local)
    const route = providerRuntime(installed, capability, [])
    expect(route.problem).toBeUndefined()
    expect(route.programs.get(program)).toBe(binary)
    if (process.platform !== 'win32') {
      expect(statSync(binary).mode & 0o111).toBe(0o100)
      expect(statSync(join(installed.directory, foreign)).mode & 0o111).toBe(0)
    }
    writeFileSync(join(base, process.platform === 'win32' ? program + '.exe' : program), 'system', { mode: 0o700 })
    const incompatible = providerRuntime({ ...installed, manifest: manifest([other]) }, capability, [base])
    expect(incompatible.problem).toContain('架构')
    expect(incompatible.programs.has(program)).toBe(false)
    if (process.platform !== 'win32') {
      chmodSync(binary, 0o600)
      expect(providerRuntime(installed, capability, [base]).problem).toContain('随包程序不可用')
    }
    writeFileSync(binary, 'modified')
    expect(manager.available(base)[0].problem).toContain('安装文件异常')
    rmSync(binary)
    expect(providerRuntime(installed, capability, [base]).programs.has(program)).toBe(false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
