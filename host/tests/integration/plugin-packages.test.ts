import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { packPlugin } from '../../scripts/plugins/pack'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { PackageInstallations } from '../../src/plugin-packages/installations'
import { PackageManager } from '../../src/plugin-packages/manager'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { loadExternalCore, setBinding } from '../../src/core/external-plugins'
import { corePlugins } from '../../src/plugins/core'
import { PLUGINS } from '../../src/plugins/manifest'
import { resolvePluginPlan } from '../../src/shared/plugin-plan'
import { packageInfo, type PackageRef } from '../../src/shared/external-plugins'

const folders: string[] = []
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'rm-plugin-test-')); folders.push(p); return p }
let example: Buffer
beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), 'rm-plugin-build-'))
  try {
    cpSync(resolve('examples/local-plugin'), join(work, 'source'), { recursive: true })
    const descriptorPath = join(work, 'source/plugin.json')
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
    descriptor.uiFeatures = ['file-working-copy-service-v1']
    const uiPath = join(work, 'source/ui.tsx')
    writeFileSync(uiPath, readFileSync(uiPath, 'utf8') + '\nimport type { FileEditingTask } from \'@resource-manager/plugin-api/ui/file-editing\'\nexport const editingTasks = (host: UiHost): Promise<FileEditingTask[]> => host.fileEditing.list()\n')
    const displayImports = "import { useUiEffect, useUiFrame } from '@resource-manager/plugin-api/ui/hooks'\nimport { useUiDocument, UiPortal } from '@resource-manager/plugin-api/ui/widgets'\n"
    writeFileSync(uiPath, displayImports + readFileSync(uiPath, 'utf8').replace('const kinds = useKinds()', 'const kinds = useKinds(); const doc = useUiDocument(); const frame = useUiFrame(); useUiEffect(d => { d.onWindow(\'resize\', () => frame(() => {})) }, [frame])').replace('<h2>', '<UiPortal><span hidden data-document={doc.title}/></UiPortal><h2>'))
    descriptor.catalog = { category: 'information', keywords: ['复看'], usage: '在素材详情添加备忘' }
    writeFileSync(descriptorPath, JSON.stringify(descriptor))
    await packPlugin(join(work, 'source'), join(work, 'example.hyplugin'))
    example = readFileSync(join(work, 'example.hyplugin'))
  } finally { rmSync(work, { recursive: true, force: true }) }
}, 60000)
afterEach(() => { for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true }) })

describe('独立插件发布物', () => {
  it('从仓库外目录打包核心、界面、样式及资源，React/公共上下文由宿主提供', () => {
    const pack = decodePackage(example)
    expect(pack.files.has('core.mjs')).toBe(true)
    expect(pack.files.has('ui.mjs')).toBe(true)
    expect(pack.files.has('ui.css')).toBe(true)
    expect(pack.files.has('assets/icon.svg')).toBe(true)
    const ui = pack.files.get('ui.mjs')!.toString()
    expect(ui).toContain('__rmPluginSdk')
    expect(ui).not.toContain('function createContext')
    expect(ui).toContain('useUiEffect')
    expect(ui).toContain('UiPortal')
    expect(ui).not.toContain('entity-cache')
    expect(pack.manifest.uiFeatures).toEqual(['file-working-copy-service-v1'])
    expect(pack.manifest.styles).toEqual(['ui.css'])
    expect(pack.manifest.catalog).toEqual({ category: 'information', keywords: ['复看'], usage: '在素材详情添加备忘' })
  })
  it('损坏内容、未知格式及越界/重复路径不能安装', () => {
    expect(() => decodePackage(Buffer.from('not a plugin'))).toThrow()
    const pack = decodePackage(example)
    for (const name of ['../outside.mjs', '/outside.mjs', 'A.mjs', 'folder/../outside.mjs']) {
      const files = new Map(pack.files)
      files.set(name, Buffer.from('x'))
      if (name === 'A.mjs') files.set('a.mjs', Buffer.from('y'))
      expect(() => encodePackage(pack.manifest, files)).toThrow()
    }
    const bad = Buffer.concat([Buffer.from('RMPLUGIN1\n'), gzipSync(Buffer.from(JSON.stringify({ manifest: pack.manifest, files: [{ path: 'ui.mjs', content: 'eA==', sha256: 'bad' }] })))])
    expect(() => decodePackage(bad)).toThrow('摘要')
  })
  it('纯安装不执行代码；重复包幂等，同版本不同内容与内置覆盖被拒绝', () => {
    const manager = new PackageManager(temp(), PLUGINS.map(p => p.id)), pack = decodePackage(example)
    pack.files.set('core.mjs', Buffer.from('throw new Error("must not execute during install")'))
    const ref = manager.install(encodePackage(pack.manifest, pack.files))
    manager.install(encodePackage(pack.manifest, pack.files))
    expect(manager.list()).toHaveLength(1)
    expect(() => manager.install(example)).toThrow('不同内容')
    expect(() => manager.install(encodePackage({ ...pack.manifest, id: 'file' }, pack.files))).toThrow('内置')
    manager.uninstall(ref.hash)
    expect(manager.list()).toEqual([])
    expect(existsSync(manager.directory(ref.hash))).toBe(false)
  })
  it('本机授权按仓库路径隔离；启动中断会阻止重复执行；文件篡改/链接被发现', () => {
    const userData = temp(), root = temp(), other = temp(), manager = new PackageManager(userData, [])
    const ref = manager.install(example)
    expect(manager.begin(root)[0].problem).toContain('尚未')
    manager.ready(root); manager.grant(root, ref.hash)
    expect(manager.begin(root)[0].problem).toBeUndefined()
    expect(new PackageManager(userData, []).begin(root)[0].problem).toContain('上次启动')
    expect(manager.begin(other)[0].problem).toContain('尚未')
    manager.ready(root); manager.grant(root, ref.hash)
    writeFileSync(join(manager.directory(ref.hash), 'ui.mjs'), 'changed')
    expect(manager.begin(root)[0].problem).toContain('安装文件异常')
    rmSync(join(manager.directory(ref.hash), 'ui.mjs'))
    // 目录联接在普通 Windows 用户下也可创建；文件解析同样必须拒绝它。
    symlinkSync(temp(), join(manager.directory(ref.hash), 'ui.mjs'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => manager.file(ref.hash, 'ui.mjs')).toThrow('符号链接')
  })
})

describe('批量安装预览', () => {
  const bytes = (id: string, version = '1.0.0', content = '') => {
    const pack = decodePackage(example)
    return encodePackage({ ...pack.manifest, id, version, coreFeatures: [], entries: { ui: 'ui.mjs' }, styles: [] }, new Map([['ui.mjs', Buffer.from(`export const plugin={id:${JSON.stringify(id)}};${content}`)]]))
  }
  const file = (root: string, name: string, data: Buffer) => { const path = join(root, name); writeFileSync(path, data); return path }

  it('混合批次逐项预览，去重、跳过已装包、拒绝冲突；确认使用快照且不授权或启用', () => {
    const root = temp(), manager = new PackageManager(temp(), ['file']), batches = new PackageInstallations(() => manager)
    manager.install(example)
    const a = bytes('demo-a'), original = file(root, 'a.hyplugin', a)
    const paths = [original, file(root, 'a-copy.rmplugin', a), file(root, 'broken.hyplugin', Buffer.from('broken')),
      file(root, 'existing.rmplugin', example), file(root, 'a-v2.rmplugin', bytes('demo-a', '2.0.0')),
      file(root, 'conflict-one.rmplugin', bytes('demo-conflict')), file(root, 'conflict-two.rmplugin', bytes('demo-conflict', '1.0.0', '// different')),
      file(root, 'reserved.rmplugin', bytes('file'))]
    const preview = batches.preview(1, paths)!
    expect(preview.items.map(r => r.status)).toEqual(['ready', 'duplicate', 'invalid', 'existing', 'ready', 'invalid', 'invalid', 'invalid'])
    expect(manager.list()).toHaveLength(1)
    preview.items[0].status = 'invalid' // 返回副本不改变主进程持有的确认内容。
    rmSync(original)
    expect(() => batches.install(2, preview.token)).toThrow('失效')
    const result = batches.install(1, preview.token)
    expect(result.items.map(r => r.status)).toEqual(['installed', 'duplicate', 'invalid', 'existing', 'installed', 'invalid', 'invalid', 'invalid'])
    expect(manager.list()).toHaveLength(3)
    expect(batches.install(1, preview.token)).toEqual(result)
    expect(JSON.parse(readFileSync(join(manager.root, 'registry.json'), 'utf8')).grants).toEqual({})
    expect(() => batches.preview(1, Array(51).fill(paths[1]))).toThrow('50')
    expect(() => batches.install(1, preview.token)).toThrow('失效')
  })

  it('单项失败不阻断其他包，重试只处理失败项；新预览、取消和其他窗口安装可接续', () => {
    const root = temp(), manager = new PackageManager(temp(), []), batches = new PackageInstallations(() => manager)
    const a = bytes('demo-a'), b = bytes('demo-b'), paths = [file(root, 'a.hyplugin', a), file(root, 'b.rmplugin', b)]
    const preview = batches.preview(1, paths)!, install = manager.install.bind(manager)
    const attempt = vi.spyOn(manager, 'install').mockImplementation(input => { if (input.equals(a)) throw new Error('模拟写入失败'); return install(input) })
    const result = batches.install(1, preview.token)
    expect(result.items.map(r => r.status)).toEqual(['failed', 'installed'])
    expect(manager.list().map(p => p.manifest.id)).toEqual(['demo-b'])
    attempt.mockClear(); attempt.mockImplementation(install)
    expect(batches.install(1, preview.token).items.map(r => r.status)).toEqual(['installed', 'installed'])
    expect(attempt).toHaveBeenCalledTimes(1)
    attempt.mockRestore()
    const c = bytes('demo-c'), next = batches.preview(1, [file(root, 'c.rmplugin', c)])!
    expect(() => batches.install(1, preview.token)).toThrow('失效')
    batches.clear(1, preview.token) // 旧窗口界面迟到的取消不能清掉新的预览。
    manager.install(c) // 预览之后另一个窗口已安装。
    expect(batches.install(1, next.token).items[0].status).toBe('existing')
    batches.clear(1, next.token)
    expect(() => batches.install(1, next.token)).toThrow('失效')
    const canceled = batches.preview(3, paths)!
    expect(batches.preview(3, [])).toBeNull()
    expect(() => batches.install(3, canceled.token)).toThrow('失效')
  })
})

describe('按仓库装配与数据保留', () => {
  async function start(root: string, manager: PackageManager) {
    const lib = openLibrary(root)
    try {
      const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, manager.begin(root))
      const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
      manager.ready(root)
      return host
    } catch (e) { if (lib.db.open) lib.close(); throw e }
  }
  const bind = (root: string, ref: PackageRef, enabled: boolean) => {
    const lib = openLibrary(root)
    try { setBinding(lib, { ...ref, enabled }, PLUGINS) } finally { lib.close() }
  }
  it('纯界面和纯核心包可以独立启用，不要求补齐空入口', async () => {
    for (const side of ['ui', 'core'] as const) {
      const source = temp(), id = `demo-${side}`, output = join(source, 'test.rmplugin')
      writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id, title: id, description: '单入口验证', author: 'test', version: '1.0.0', apiVersion: 1, entries: { [side]: `./${side}.ts` } }))
      writeFileSync(join(source, `${side}.ts`), `import type { ${side === 'ui' ? 'UiPlugin' : 'CorePlugin'} } from '@resource-manager/plugin-api/${side}/contracts'; export const plugin: ${side === 'ui' ? 'UiPlugin' : 'CorePlugin'} = { id: '${id}'${side === 'core' ? ', version: 1' : ''} };`)
      await packPlugin(source, output)
      const manager = new PackageManager(temp(), []), root = temp()
      const ref = manager.install(readFileSync(output))
      manager.grant(root, ref.hash); bind(root, ref, true)
      const host = await start(root, manager)
      try {
        expect(host.plan.enabled.has(id)).toBe(true)
        expect((await host.api.plugins()).find(p => p.id === id)?.enabled).toBe(true)
      } finally { host.close() }
    }
  })
  it('安装/启用/操作回执与撤销/停用/卸载/重新安装，原始字段可查可取回', async () => {
    const manager = new PackageManager(temp(), PLUGINS.map(p => p.id)), root = temp()
    const ref = manager.install(example)
    bind(root, ref, true)
    let host = await start(root, manager)
    expect(host.plan.enabled.has(ref.manifest.id)).toBe(false) // 库里的配置不能代替本机授权
    host.close(); manager.grant(root, ref.hash)
    host = await start(root, manager)
    let id: string
    try {
      expect(host.plan.enabled.has(ref.manifest.id)).toBe(true)
      id = host.api.create({ 'demo-reviewmemo': { text: '构图初稿' } }) as string
      const result = host.api.executeOperation({ operation: 'demo_update_reviewmemo', requestId: 'pack-test-request-1', args: { id, text: '构图终稿' } })
      expect(result).toBeTruthy()
      expect(host.api.query({ text: '终稿' })).toMatchObject({ ids: [id] })
      host.api.undo()
      expect(host.api.query({ text: '初稿' })).toMatchObject({ ids: [id] })
    } finally { host.close() }
    bind(root, ref, false)
    host = await start(root, manager)
    try {
      expect(host.reg.kind('demo-reviewmemo')?.dormant).toBe(true)
      expect(host.api.query({ text: '初稿' })).toMatchObject({ ids: [id!] })
      expect(() => host.api.patch(id!, 'demo-reviewmemo', { text: 'bad' })).toThrow()
    } finally { host.close() }
    manager.uninstall(ref.hash)
    host = await start(root, manager)
    try { expect(host.api.readContent({ id: id!, kind: 'demo-reviewmemo', field: 'text' })).toMatchObject({ text: '构图初稿' }) } finally { host.close() }
    manager.install(example); manager.grant(root, ref.hash); bind(root, ref, true)
    host = await start(root, manager)
    try {
      expect(host.reg.kind('demo-reviewmemo')?.dormant).not.toBe(true)
      expect(host.api.query({ text: '初稿' })).toMatchObject({ ids: [id!] })
    } finally { host.close() }
  })
  it('加载异常、未知硬依赖与结构变化不覆盖旧定义，不阻止仓库打开', async () => {
    const manager = new PackageManager(temp(), []), root = temp(), ref = manager.install(example)
    manager.grant(root, ref.hash); bind(root, ref, true)
    let host = await start(root, manager)
    const id = host.api.create({ 'demo-reviewmemo': { text: '旧数据' } }) as string
    host.close()
    const pack = decodePackage(example)
    pack.files.set('core.mjs', Buffer.from('export const blocks = []; export const plugin = { id: "demo-reviewmemo", version: 2, blocks };'))
    const next = manager.install(encodePackage({ ...pack.manifest, version: '1.0.1' }, pack.files))
    manager.grant(root, next.hash); bind(root, next, true)
    host = await start(root, manager)
    try {
      expect(host.plan.off.get(ref.manifest.id)).toContain('持久数据结构')
      expect(host.reg.kind(ref.manifest.id)?.dormant).toBe(true)
      expect(host.api.query({ text: '旧数据' })).toMatchObject({ ids: [id] })
    } finally { host.close() }
    pack.files.set('core.mjs', Buffer.from('throw new Error("坏入口")'))
    const broken = manager.install(encodePackage({ ...pack.manifest, version: '1.0.2' }, pack.files))
    manager.grant(root, broken.hash); bind(root, broken, true)
    host = await start(root, manager)
    try { expect(host.plan.off.get(ref.manifest.id)).toContain('坏入口') } finally { host.close() }
    const uiOnly = manager.install(encodePackage({ ...pack.manifest, version: '1.0.3', coreFeatures: [], entries: { ui: 'ui.mjs' } }, pack.files))
    manager.grant(root, uiOnly.hash); bind(root, uiOnly, true)
    host = await start(root, manager)
    try {
      expect(host.plan.off.get(ref.manifest.id)).toContain('持久数据结构')
      expect(host.api.query({ text: '旧数据' })).toMatchObject({ ids: [id] })
    } finally { host.close() }
    const required = packageInfo({ ...ref, manifest: { ...ref.manifest, requires: ['not-installed'] } })
    expect(resolvePluginPlan([], [...PLUGINS, required]).off.get(required.id)).toContain('缺少依赖')
    expect(resolvePluginPlan([], [...PLUGINS, { ...required, requires: [], optional: ['not-installed'] }]).enabled.has(required.id)).toBe(true)
  })
})
