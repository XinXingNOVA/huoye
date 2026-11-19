import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PackageManager } from '../../src/plugin-packages/manager'
import { ManagedInstallations } from '../../src/plugin-packages/managed-installations'
import { SuiteCatalog, encodeSuite } from '../../src/plugin-packages/suites'
import { encodePackage, decodePackage, digest } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { suiteManifestSchema } from '../../src/shared/plugin-suites'
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const bytes = (id: string, version = '1.0.0') => encodePackage(packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id, title: id, version, author: 'test', description: '', entries: { core: 'core.mjs' } }), new Map([['core.mjs', Buffer.from('throw new Error("never execute")')]]))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-managed-install-')); dirs.push(dir)
  const manager = new PackageManager(dir, ['file']), suites = new SuiteCatalog(join(dir, 'suites.json'))
  const store = () => new ManagedInstallations(join(dir, 'jobs'), manager, suites)
  const file = (name: string, data: Buffer) => { const path = join(dir, name); writeFileSync(path, data); return path }
  return { dir, manager, suites, store, file }
}
it('安装不执行或默认信任；人工许可固定字节与版本，源文件替换、重启和重复请求不改变目标', () => {
  const f = fixture(), original = bytes('probe'), file = f.file('probe.hyplugin', original), id = 'install-fixed'
  expect(f.store().request(id, [file]).approvalRequired).toHaveLength(1)
  expect(f.store().install(id)).toMatchObject({ state: 'pending', error: expect.stringContaining('PACKAGE_APPROVAL_REQUIRED') })
  expect(f.manager.list()).toEqual([])
  writeFileSync(file, bytes('other'))
  f.store().approve(id)
  expect(f.store().install(id).state).toBe('completed')
  expect(f.manager.list().map(p => p.manifest.id)).toEqual(['probe'])
  expect(f.store().install(id).state).toBe('completed')
  expect(() => f.store().request(id, [file, file])).toThrow('REQUEST_CONFLICT')
  const hash = decodePackage(original).hash
  expect(new PackageManager(f.dir, ['file']).automationAllowed(hash)).toBe(true)
  const next = f.file('v2.rmplugin', bytes('probe', '2.0.0'))
  expect(f.store().request('next-version', [next]).approvalRequired).toHaveLength(1)
  expect(f.manager.authorization('/unused', hash)).toBe('approval-required') // 应用许可不提前授予本库运行。
})
it('部分安装失败可接续且不重装成功项；撤回许可阻止下一次安装，取消不删成功包', () => {
  const f = fixture(), id = 'partial-install', a = bytes('first'), b = bytes('second')
  f.store().request(id, [f.file('a.rmplugin', a), f.file('b.rmplugin', b)]); f.store().approve(id)
  const install = f.manager.install.bind(f.manager)
  const spy = vi.spyOn(f.manager, 'install').mockImplementation(data => { if (data.equals(b)) throw new Error('disk full'); return install(data) })
  const first = f.store().install(id)
  expect(first.state).toBe('pending'); expect(first.preview.items.map(r => r.status)).toEqual(['installed', 'failed'])
  const ref = decodePackage(b)
  f.manager.setAutomationPermission([{ manifest: ref.manifest, hash: ref.hash }], false)
  expect(f.store().install(id).approvalRequired).toHaveLength(1)
  spy.mockRestore(); f.store().approve(id)
  const retry = vi.spyOn(f.manager, 'install')
  expect(f.store().install(id).state).toBe('completed'); expect(retry).toHaveBeenCalledOnce()
  f.store().request('cancel-install', [f.file('c.rmplugin', bytes('third'))]); f.store().cancel('cancel-install')
  expect(f.store().install('cancel-install').state).toBe('cancelled'); expect(f.manager.list()).toHaveLength(2)
})
it('套件固定确切包、不采用已有旧版本；不通过 AI 更新已登记套件', () => {
  const f = fixture(), exact = bytes('reader', '2.0.0'), old = f.manager.install(bytes('reader'))
  const manifest = suiteManifestSchema.parse({ formatVersion: 1, id: 'study', title: '学习', description: '', version: '1.0.0', packages: [{ id: 'reader', file: 'reader.hyplugin', version: '2.0.0', hash: digest(exact) }], presets: [{ id: 'read', title: '阅读', plugins: [{ id: 'reader', title: '阅读', hash: digest(exact) }] }] })
  const file = f.file('study.hysuite', encodeSuite(manifest, new Map([['reader.hyplugin', exact]])))
  f.store().request('suite-install', [file]); f.store().approve('suite-install')
  const result = f.store().install('suite-install')
  expect(result.state).toBe('completed'); expect(f.manager.list()).toHaveLength(2)
  expect(f.manager.automationAllowed(old.hash)).toBe(false)
  writeFileSync(file, encodeSuite({ ...manifest, version: '2.0.0' }, new Map([['reader.hyplugin', exact]])))
  expect(() => f.store().request('suite-update', [file])).toThrow('不更新已有套件')
})
it('安装快照和已安装字节的损坏不会被报告为成功', () => {
  const f = fixture(), file = f.file('p.rmplugin', bytes('probe')), id = 'bad-snapshot'
  f.store().request(id, [file]); writeFileSync(join(f.dir, 'jobs', id, 'files', '0', 'p.rmplugin'), 'tampered')
  expect(() => f.store().approve(id)).toThrow('快照已改变')
  expect(f.store().install(id).state).toBe('pending')
  const ref = f.manager.install(readFileSync(file)); f.manager.setAutomationPermission([ref], true)
  writeFileSync(f.manager.file(ref.hash, 'core.mjs'), 'tampered')
  f.store().request('bad-installed', [file])
  expect(f.store().install('bad-installed')).toMatchObject({ state: 'pending', preview: { items: [{ status: 'failed' }] } })
})
