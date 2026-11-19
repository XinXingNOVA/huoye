import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PluginBuildCache } from '../../scripts/plugins/build-cache'
import { buildPluginPackages } from '../../scripts/plugins/build-bundled'
import { decodePackage } from '../../src/plugin-packages/archive'
import { bundledDescriptors } from '../../scripts/plugins/distribution'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rm-build-cache-')); folders.push(root)
  const cache = join(root, 'cache'), output = join(root, 'output'), source = join(root, 'packaging', 'plugins', 'alpha')
  mkdirSync(source, { recursive: true }); writeFileSync(join(root,'.plugin-sources.local.json'),JSON.stringify({alpha:source,music:join(root,'packaging/plugins/music')}))
  writeFileSync(join(source, 'distribution.json'), JSON.stringify({ group: 'optional', defaultEnabled: false }))
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'alpha', title: 'Alpha', description: 'cache fixture', author: 'test', version: '1.0.0', apiVersion: 1, entries: { ui: './ui.ts' } }))
  writeFileSync(join(source, 'ui.ts'), `import type { UiPlugin } from '@resource-manager/plugin-api/ui/contracts'; import { title } from './label'; import './style.css'; export type { Data } from './model'; export const plugin: UiPlugin = { id:'alpha', sections:[{id:'alpha.info', title, order:1, kinds:[], Component:()=>null}] };`)
  writeFileSync(join(source, 'label.ts'), `export const title = 'before'`)
  writeFileSync(join(source, 'model.ts'), `export interface Data { value: string }`)
  writeFileSync(join(source, 'style.css'), '.alpha { color: red; }')
  mkdirSync(join(source, 'assets')); writeFileSync(join(source, 'assets/info.txt'), 'asset')
  const packageFile = join(output, 'alpha.rmplugin')
  const pack = () => new PluginBuildCache(cache).pack(source, packageFile)
  return { root, cache, output, source, packageFile, pack }
}

it('批量打包在原生 Node 中运行，不依赖 Vite 转译 TypeScript', () => {
  const f = fixture(), entry = pathToFileURL(resolve('scripts/plugins/build-bundled.ts')).href
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { buildPluginPackages } from ${JSON.stringify(entry)};
    await buildPluginPackages(${JSON.stringify(f.output)}, ${JSON.stringify(f.root)});
  `], { cwd: f.root, encoding: 'utf8' })
  expect(JSON.parse(readFileSync(join(f.output, 'catalog.json'), 'utf8'))).toEqual([
    { file: 'alpha.rmplugin', hash: decodePackage(readFileSync(f.packageFile)).hash }
  ])
})

it('外部源码只有明确发行声明才进入清单与批量打包，移动目录不授予附带资格', async () => {
  const f = fixture(), optional = join(f.root, 'packaging/plugins/music')
  mkdirSync(optional)
  writeFileSync(join(optional, 'plugin.json'), JSON.stringify({ id: 'music', title: 'Music', description: 'standalone', author: 'test', version: '1.0.0', apiVersion: 1, entries: { ui: './ui.ts' } }))
  writeFileSync(join(optional, 'ui.ts'), "export const plugin = { id: 'music' }")
  expect(bundledDescriptors(f.root).map(p => p.info.id)).toEqual(['alpha'])
  expect((await buildPluginPackages(f.output, f.root)).map(p => p.file)).toEqual(['alpha.rmplugin'])
  expect(readdirSync(f.output)).not.toContain('music.rmplugin')
  writeFileSync(join(optional, 'distribution.json'), JSON.stringify({ group: 'optional', defaultEnabled: false }))
  expect(bundledDescriptors(f.root).map(p => p.info.id)).toEqual(['alpha', 'music'])
  expect((await buildPluginPackages(f.output, f.root)).map(p => p.file)).toEqual(['alpha.rmplugin', 'music.rmplugin'])
  writeFileSync(join(optional, 'distribution.json'), '{"group":"base","defaultEnabled":true}')
  await expect(buildPluginPackages(f.output, f.root)).rejects.toThrow('发行策略无效')
})

it('第二次进程式构建复用完全相同的包，删除 out 后仍可恢复；修改单个插件不重建其他包', async () => {
  const f = fixture()
  expect(await f.pack()).toBe('built')
  const original = readFileSync(f.packageFile)
  rmSync(f.output, { recursive: true })
  expect(await f.pack()).toBe('cached')
  expect(readFileSync(f.packageFile)).toEqual(original)
  const other = join(f.root, 'packaging/plugins/beta'); mkdirSync(other)
  writeFileSync(join(other, 'plugin.json'), JSON.stringify({ id:'beta', title:'Beta', description:'test', author:'test', version:'1.0.0', apiVersion:1, entries:{ui:'./ui.ts'} }))
  writeFileSync(join(other, 'ui.ts'), `export const plugin = { id: 'beta' }`)
  expect(await new PluginBuildCache(f.cache).pack(other, join(f.output, 'beta.rmplugin'))).toBe('built')
  writeFileSync(join(f.source, 'label.ts'), `export const title = 'after!'`)
  expect(await f.pack()).toBe('built')
  expect(await new PluginBuildCache(f.cache).pack(other, join(f.output, 'beta.rmplugin'))).toBe('cached')
})

it('内容而非 mtime 决定失效，样式和资源的新增／删除都会进入新包', async () => {
  const f = fixture(); await f.pack()
  const label = join(f.source, 'label.ts'), stat = statSync(label)
  writeFileSync(label, `export const title = 'after!'`); utimesSync(label, stat.atime, stat.mtime)
  expect(await f.pack()).toBe('built')
  expect(decodePackage(readFileSync(f.packageFile)).files.get('ui.mjs')!.toString()).toContain('after!')
  writeFileSync(join(f.source, 'style.css'), '.alpha { color: blue; }')
  expect(await f.pack()).toBe('built')
  expect(decodePackage(readFileSync(f.packageFile)).files.get('ui.css')!.toString()).toContain('blue')
  writeFileSync(join(f.source, 'assets/new.txt'), 'new'); rmSync(join(f.source, 'assets/info.txt'))
  mkdirSync(join(f.source, 'assets/node_modules')); writeFileSync(join(f.source, 'assets/node_modules/data.txt'), 'nested asset')
  expect(await f.pack()).toBe('built')
  const files = decodePackage(readFileSync(f.packageFile)).files
  expect(files.has('assets/new.txt')).toBe(true); expect(files.has('assets/info.txt')).toBe(false)
  writeFileSync(join(f.source, 'assets/node_modules/data.txt'), 'changed nested asset')
  expect(await f.pack()).toBe('built')
  expect(decodePackage(readFileSync(f.packageFile)).files.get('assets/node_modules/data.txt')!.toString()).toBe('changed nested asset')
})

it('类型专用文件中的错误不能被旧缓存绕过；修正后重新校验', async () => {
  const f = fixture(); await f.pack()
  writeFileSync(join(f.source, 'model.ts'), `export type Data = ThisTypeDoesNotExist`)
  await expect(f.pack()).rejects.toThrow(/ThisTypeDoesNotExist/)
  await expect(f.pack()).rejects.toThrow(/ThisTypeDoesNotExist/)
  writeFileSync(join(f.source, 'model.ts'), `export interface Data { value: number }`)
  expect(await f.pack()).toBe('built')
})

it('实际第三方依赖和 package.json 入口变化会失效，即使没有改源码或依赖锁', async () => {
  const f = fixture(), dep = join(f.source, 'node_modules/cache-dep'); mkdirSync(dep, { recursive: true })
  const manifest = { name:'cache-dep', version:'1.0.0', main:'index.js', types:'index.d.ts' }
  writeFileSync(join(dep, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dep, 'index.js'), `export const title = 'dependency-a'`)
  writeFileSync(join(dep, 'index.d.ts'), 'export const title: string')
  writeFileSync(join(f.source, 'label.ts'), `export { title } from 'cache-dep'`)
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ name: 'alpha', dependencies: {} }))
  await expect(f.pack()).rejects.toThrow('插件未声明依赖：cache-dep')
  writeFileSync(join(f.source, 'package.json'), JSON.stringify({ name: 'alpha', dependencies: { 'cache-dep': '1.0.0' } }))
  expect(await f.pack()).toBe('built'); expect(await f.pack()).toBe('cached')
  writeFileSync(join(dep, 'index.js'), `export const title = 'dependency-b'`)
  expect(await f.pack()).toBe('built')
  writeFileSync(join(dep, 'next.js'), `export const title = 'dependency-c'`)
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ ...manifest, main:'next.js' }))
  expect(await f.pack()).toBe('built')
  expect(decodePackage(readFileSync(f.packageFile)).files.get('ui.mjs')!.toString()).toContain('dependency-c')
  writeFileSync(join(dep, 'index.d.ts'), 'export const title: number')
  await expect(f.pack()).rejects.toThrow(/number/)
})

it('损坏的包或回执自动重建；正常发布路径始终执行检查并剔除已删插件', async () => {
  const f = fixture(); await f.pack()
  writeFileSync(join(f.cache, readdirSync(f.cache).find(n => n.endsWith('.rmplugin'))!), 'broken')
  expect(await f.pack()).toBe('built')
  writeFileSync(join(f.cache, readdirSync(f.cache).find(n => n.endsWith('.json'))!), '{}')
  expect(await f.pack()).toBe('built')
  const normal = await buildPluginPackages(join(f.root, 'release'), f.root)
  expect(normal[0].hash).toBe(decodePackage(readFileSync(f.packageFile)).hash)
  writeFileSync(join(f.source, 'model.ts'), 'export type Data = InvalidType')
  await expect(buildPluginPackages(join(f.root, 'release'), f.root)).rejects.toThrow(/InvalidType/)
  rmSync(f.source, { recursive: true })
  expect(await buildPluginPackages(join(f.root, 'release'), f.root, { cacheDirectory:f.cache })).toEqual([])
  expect(JSON.parse(readFileSync(join(f.root, 'release/catalog.json'), 'utf8'))).toEqual([])
})
