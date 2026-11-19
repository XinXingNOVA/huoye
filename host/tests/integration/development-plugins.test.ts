import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DevelopmentPackages } from '../../src/plugin-packages/development'
import { PackageManager } from '../../src/plugin-packages/manager'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { packageManifestSchema } from '../../src/shared/external-plugins'
import { loadExternalCore, readBindings, setBinding } from '../../src/core/external-plugins'
import { Host } from '../../src/core/host'
import { openLibrary } from '../../src/core/library'
import { tempDir } from '../helpers/helpers'
import { startPluginDevelopment } from '../../scripts/plugins/dev'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = () => { const root = tempDir('rm-development-'); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root }
const bytes = (label = 'first', id = 'demo-dev', shape = 'longtext') => {
  const manifest = packageManifestSchema.parse({ formatVersion: 1, apiVersion: 1, id, title: '开发测试', description: label, author: 'test', version: '1.0.0', entries: { core: 'core.mjs' } })
  const core = `export const blocks = [{id:'${id}',plugin:'${id}',title:'测试',version:1,content:true,rebuildable:false,fields:{text:{type:'${shape}',title:'正文',search:true}}}];
export const plugin={id:'${id}',version:1,blocks,commands:{edit(ctx,args){ctx.put(args.id,'${id}',{text:'${label}'});return {label:'编辑'}}}};`
  return encodePackage(manifest, new Map([['core.mjs', Buffer.from(core)]]))
}
const until = async (fn: () => boolean, label: string) => {
  for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 100)) }
  throw new Error(label)
}

// 模拟目录构建器准备好的快照，统一经批量选择入口接续。
function apply(dev: DevelopmentPackages, root: string, path: string, hash = decodePackage(readFileSync(path)).hash) {
  writeFileSync(path + '.status.json', JSON.stringify({ state: 'ready' }))
  dev.applySources(root, [...dev.links(root).filter(l => l.path !== path).map(l => ({ source: l.source!, path: l.path, hash: l.hash })), { source: path + '.source', path, hash }])
}
function refresh(dev: DevelopmentPackages, root: string) {
  dev.applySources(root, dev.links(root).map(l => ({ source: l.source!, path: l.path, hash: decodePackage(readFileSync(l.path)).hash })))
}

describe('本机开发覆盖', () => {
  it('受限批量应用只替换授权来源，保留其他开发覆盖且拒绝插件身份冲突', () => {
    const root = temp(), folder = temp(), dev = new DevelopmentPackages(temp(), [])
    const a = join(folder, 'a'), b = join(folder, 'b')
    writeFileSync(a, bytes('first', 'demo-a')); writeFileSync(b, bytes('first', 'demo-b'))
    apply(dev, root, a); apply(dev, root, b)
    const original = dev.links(root), preserved = original.find(l => l.manifest.id === 'demo-b')!
    writeFileSync(a, bytes('changed', 'demo-a'))
    const entry = { source: a + '.source', path: a, hash: decodePackage(readFileSync(a)).hash }
    expect(() => dev.applySources(root, [entry], [b + '.source'])).toThrow()
    dev.applySources(root, [entry], [a + '.source'])
    expect(dev.links(root).find(l => l.manifest.id === 'demo-b')).toEqual(preserved)
    writeFileSync(a, bytes('collision', 'demo-b'))
    expect(() => dev.applySources(root, [{ ...entry, hash: decodePackage(readFileSync(a)).hash }], [a + '.source'])).toThrow()
    expect(dev.links(root).find(l => l.manifest.id === 'demo-b')).toEqual(preserved)
    dev.applySources(root, [], [a + '.source'])
    expect(dev.links(root)).toEqual([preserved])
  })
  it('同版本新构建接续原数据，不改正式绑定，按仓库隔离；重启接续并可退出', async () => {
    const root = temp(), other = temp(), data = temp(), path = join(temp(), 'plugin.rmplugin')
    const release = new PackageManager(data, []), original = release.install(bytes())
    release.grant(root, original.hash)
    const initial = openLibrary(root); setBinding(initial, { ...original, enabled: false }, []); initial.close()
    let dev = new DevelopmentPackages(data, [])
    writeFileSync(path, bytes()); apply(dev, root, path, original.hash)
    expect(dev.links(other)).toEqual([])
    const stateFile = join(data, 'plugin-development', 'links.json')
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    saved[other] = { 'demo-dev': { ...original, path } }
    writeFileSync(stateFile, JSON.stringify(saved))
    dev = new DevelopmentPackages(data, [])
    expect(dev.begin(other)).toEqual([]) // 退役记录不执行，也不阻碍新目录覆盖。

    const launch = async () => {
      const lib = openLibrary(root)
      const assembly = await loadExternalCore(lib, [], [], [...release.begin(root), ...dev.begin(root)])
      const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
      release.ready(root); dev.packages.ready(root)
      return host
    }
    let host = await launch()
    const id = await host.api.create({ 'demo-dev': { text: '保留原文' } })
    expect(host.plan.enabled.has('demo-dev')).toBe(true)
    expect(readBindings(host.lib)).toEqual([{ ...original, enabled: false }])
    host.close()
    writeFileSync(path, bytes('second'))
    expect(() => release.install(readFileSync(path))).toThrow('提升版本')
    refresh(dev, root)
    dev = new DevelopmentPackages(data, [])
    host = await launch()
    try {
      expect((await host.api.readContent({ id, kind: 'demo-dev', field: 'text' })).text).toBe('保留原文')
      await host.api.run('demo-dev', 'edit', { id })
      expect((await host.api.readContent({ id, kind: 'demo-dev', field: 'text' })).text).toBe('second')
      expect(readBindings(host.lib)[0]).toEqual({ ...original, enabled: false })
    } finally { host.close() }
    dev.applySources(root, [])
    host = await launch()
    try {
      expect(host.plan.enabled.has('demo-dev')).toBe(false)
      expect((await host.api.readContent({ id, kind: 'demo-dev', field: 'text' })).text).toBe('second')
      expect(readBindings(host.lib)[0]).toEqual({ ...original, enabled: false })
    } finally { host.close() }
    dev.collect(); expect(dev.packages.list()).toEqual([])
  })
  it('预览失效、包缺失、损坏、构建失败均不切换旧快照', () => {
    const root = temp(), data = temp(), path = join(temp(), 'dev.rmplugin'), dev = new DevelopmentPackages(data, [])
    const first = bytes(), hash = decodePackage(first).hash
    writeFileSync(path, first)
    expect(() => apply(dev, root, path, '0'.repeat(64))).toThrow('已变化')
    apply(dev, root, path, hash)
    for (const content of [Buffer.from('broken')]) {
      writeFileSync(path, content); expect(() => refresh(dev, root)).toThrow()
      expect(dev.links(root)[0].hash).toBe(hash)
    }
    writeFileSync(path, bytes('second')); writeFileSync(`${path}.status.json`, JSON.stringify({ state: 'error', message: '类型错误' }))
    expect(() => refresh(dev, root)).toThrow('未就绪')
    rmSync(path); expect(() => refresh(dev, root)).toThrow()
    expect(dev.links(root)[0].hash).toBe(hash)
  })
  it('整批刷新先检查，再切换；基础 ID 不能被开发包覆盖，结构检查仍执行', async () => {
    const root = temp(), data = temp(), folder = temp(), dev = new DevelopmentPackages(data, ['file'])
    expect(() => dev.packages.install(bytes('reserved', 'file'))).toThrow('内置')
    for (const id of ['demo-a', 'demo-b']) {
      const path = join(folder, `${id}.rmplugin`), content = bytes('first', id)
      writeFileSync(path, content); apply(dev, root, path, decodePackage(content).hash)
    }
    const old = dev.links(root)
    writeFileSync(join(folder, 'demo-a.rmplugin'), bytes('second', 'demo-a'))
    writeFileSync(join(folder, 'demo-b.rmplugin'), 'bad')
    expect(() => refresh(dev, root)).toThrow(); expect(dev.links(root)).toEqual(old)
    let lib = openLibrary(root)
    try {
      const initial = await loadExternalCore(lib, [], [], dev.begin(root)); dev.packages.ready(root)
      expect(initial.manifest.every(p => !p.problem)).toBe(true)
      const host = new Host(root, initial.plugins, () => {}, { library: lib, manifest: initial.manifest })
      host.close(); lib = openLibrary(root)
      writeFileSync(join(folder, 'demo-a.rmplugin'), bytes('wrong shape', 'demo-a', 'number'))
      writeFileSync(join(folder, 'demo-b.rmplugin'), bytes('first', 'demo-b')); refresh(dev, root)
      const result = await loadExternalCore(lib, [], [], dev.begin(root))
      expect(result.manifest.find(p => p.id === 'demo-a')?.problem).toContain('结构')
      expect(result.plugins.some(p => p.id === 'demo-a')).toBe(false)
    } finally { lib.close() }
  })
  it('启动中断不会反复执行开发包；明确重试恢复，缓存只清理未引用快照', () => {
    const root = temp(), data = temp(), path = join(temp(), 'plugin.rmplugin'), dev = new DevelopmentPackages(data, [])
    const first = bytes(), hash = decodePackage(first).hash
    writeFileSync(path, first); apply(dev, root, path, hash)
    expect(dev.begin(root)[0].problem).toBeUndefined()
    const restarted = new DevelopmentPackages(data, [])
    expect(restarted.begin(root)[0].problem).toContain('上次启动')
    restarted.packages.ready(root); refresh(restarted, root)
    expect(restarted.begin(root)[0].problem).toBeUndefined(); restarted.packages.ready(root)
    for (const name of ['second', 'third']) { writeFileSync(path, bytes(name)); refresh(restarted, root) }
    restarted.collect([{ manifest: decodePackage(first).manifest, hash }]); expect(restarted.packages.list()).toHaveLength(3)
    restarted.collect(); expect(restarted.packages.list()).toHaveLength(2)
  })
})

it('监听源码、样式、资源和错误修复；原子发布同版本构建，失败保留旧包', async () => {
  const source = temp(), output = join(source, 'out.rmplugin')
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'demo-watch', title: '监听', description: '', author: 'test', version: '1.0.0', apiVersion: 1, entries: { ui: './ui.tsx' } }))
  const ui = "import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'; import './style.css'; export const plugin: UiPlugin = {id:'demo-watch'}"
  writeFileSync(join(source, 'ui.tsx'), ui); writeFileSync(join(source, 'style.css'), '.demo-watch {color:red}')
  mkdirSync(join(source, 'assets')); writeFileSync(join(source, 'assets/a.txt'), 'first')
  const watcher = await startPluginDevelopment(source, output, { interval: 100, log() {} }); cleanup.push(() => watcher.close())
  const status = () => JSON.parse(readFileSync(`${output}.status.json`, 'utf8'))
  await until(() => status().state === 'ready', '首次构建未就绪')
  expect(status().state, status().message).toBe('ready')
  const first = decodePackage(readFileSync(output))
  writeFileSync(join(source, 'ui.tsx'), ui + '; const invalid: number = "bad"')
  await until(() => status().state === 'error', '未报告类型错误')
  expect(decodePackage(readFileSync(output)).hash).toBe(first.hash)
  writeFileSync(join(source, 'ui.tsx'), ui); writeFileSync(join(source, 'style.css'), '.demo-watch {color:blue}'); writeFileSync(join(source, 'assets/a.txt'), 'second')
  await until(() => status().state === 'ready' && decodePackage(readFileSync(output)).hash !== first.hash, '修复后没有发布新构建')
  const second = decodePackage(readFileSync(output))
  expect(second.manifest.version).toBe('1.0.0'); expect(second.files.get('assets/a.txt')?.toString()).toBe('second')
  expect(second.files.get('ui.css')?.toString()).toContain('blue')
  await watcher.close(); expect(status().state).toBe('stopped')
}, 30000)
