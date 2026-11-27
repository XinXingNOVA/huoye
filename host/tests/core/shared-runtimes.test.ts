import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { checkManifest, encodeHeader, executable, inspectRuntime, type RuntimeManifest } from '../../src/platform/runtime-package'
import { SharedRuntimes } from '../../src/platform/shared-runtimes'
import { providerRuntime } from '../../src/core/provider-programs'
import type { InstalledPackage } from '../../src/shared/external-plugins'

let dir: string
const stores: SharedRuntimes[] = []
function openStore() {
  const store = new SharedRuntimes(dir)
  stores.push(store)
  return store
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'huoye-shared-runtime-')) })
afterEach(() => { stores.splice(0).forEach(s => s.close()); rmSync(dir, { recursive: true, force: true }) })
const target = (process.platform + '-' + process.arch) as RuntimeManifest['target']
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
function fixture(id: string, version: string) {
  const bytes = Buffer.from(version)
  const file = { path: executable('7z', target), size: bytes.length, sha256: hash(bytes) }
  const manifest = { id, version, target, programs: ['7z'], files: [file] }
  const path = join(dir, id + version + '.hyruntime')
  const header = encodeHeader(manifest)
  writeFileSync(path, Buffer.concat([header, bytes]))
  return { path, header, manifest }
}

it('只接受适配本机、路径无冲突并通过摘要核对的完整运行包', async () => {
  const pkg = fixture('archive', '1')
  const { digest } = await inspectRuntime(pkg.path)
  const [file] = pkg.manifest.files
  for (const path of ['bin/../x','/tmp/x','bin/NUL.exe','lib/X','bin/7z/child']) {
    const files = [file, { ...file, path }, { ...file, path: 'lib/x' }]
    if (path === 'bin/7z/child') files[1].path = file.path + '/child'
    expect(() => checkManifest({ ...pkg.manifest, files })).toThrow()
  }
  const store = openStore()
  writeFileSync(pkg.path, Buffer.concat([pkg.header, Buffer.from('2')]))
  await expect(store.install(pkg.path, digest)).rejects.toThrow('摘要')
  expect(store.list()).toEqual([])
  writeFileSync(pkg.path, pkg.header)
  await expect(inspectRuntime(pkg.path)).rejects.toThrow('长度')
  const other = target === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
  writeFileSync(pkg.path, Buffer.concat([encodeHeader({ ...pkg.manifest, target: other, files: [{ ...file, path: executable('7z', other) }] }), Buffer.from('1')]))
  await expect(inspectRuntime(pkg.path)).rejects.toThrow('架构')
})

it('跨管理实例共用安装、升级和占用状态，插件声明的程序走已启用的同一版本', async () => {
  const a = openStore(), b = openStore()
  const install = async (id: string, v: string) => {
    const pkg = fixture(id, v)
    const { digest } = await inspectRuntime(pkg.path)
    await Promise.all([a.install(pkg.path, digest), b.install(pkg.path, digest)])
    return digest
  }
  const v1 = await install('archive','1')
  expect(a.list()).toHaveLength(1)
  a.setEnabled(v1, true)
  const old = b.snapshot()
  const v2 = await install('archive','2')
  a.setEnabled(v2, true)
  const current = a.snapshot()
  expect(readFileSync(old.programs['7z'].path, 'utf8')).toBe('1')
  const pack = { manifest: { capabilities: { implementations: [{ id: 'c', programs: ['7z'] }] } } } as InstalledPackage
  const route = providerRuntime(pack, 'c', [], current.programs)
  expect(route.programs.get('7z')).toBe(current.programs['7z'].path)
  expect(route.versions).toEqual(['7z'])
  await expect(a.remove(v1)).rejects.toThrow('仓库')
  const conflicting = await install('other','1')
  expect(() => b.setEnabled(conflicting, true)).toThrow('同名')
  old.release()
  await a.remove(v1)
  current.release()
  expect(b.list().find(p=>p.enabled)?.digest).toBe(v2)
})

it('损坏的已选程序不能回退到系统路径，释放占用后可重装同一包修复', async () => {
  const store = openStore()
  const pkg = fixture('archive', '1')
  const { digest } = await inspectRuntime(pkg.path)
  await store.install(pkg.path, digest)
  store.setEnabled(digest, true)
  const live = store.snapshot()
  const path = live.programs['7z'].path
  const pack = { manifest: { capabilities: { implementations: [{ id: 'c', programs: ['7z'] }] } } } as InstalledPackage
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600)
    expect(store.list()[0].brokenFiles).toEqual([pkg.manifest.files[0].path])
    rmSync(path)
    const outside = join(dir, 'other-program')
    writeFileSync(outside, '1', { mode: 0o700 })
    symlinkSync(outside, path)
    expect(store.list()[0].brokenFiles).toEqual([pkg.manifest.files[0].path])
  }
  rmSync(path)
  const broken = store.snapshot()
  try {
    expect(providerRuntime(pack, 'c', [], broken.programs).problem).toContain('重新安装')
    expect(providerRuntime(pack, 'c', [], broken.programs).programs.size).toBe(0)
    await expect(store.install(pkg.path, digest)).rejects.toThrow('重载')
  } finally { live.release(); broken.release() }
  await store.install(pkg.path, digest)
  expect(store.list()[0]).toMatchObject({ enabled: true, digest })
  expect(store.list()[0].brokenFiles).toBeUndefined()
  expect(readFileSync(path, 'utf8')).toBe('1')
})

it('Windows 共享 DLL 与 EXE 放在同一层，打包时识别大小写后缀', () => {
  const { manifest } = fixture('archive', '1')
  const [file] = manifest.files
  const archive = (dll: string) => encodeHeader({ ...manifest, target: 'win32-x64',
    files: [{ ...file, path: 'bin/7z.exe' }, { ...file, path: dll }] })
  expect(() => archive('bin/helper.DLL')).not.toThrow()
  for (const path of ['lib/helper.dll', 'bin/nested/helper.DLL']) expect(() => archive(path)).toThrow('同放在 bin/')
})
