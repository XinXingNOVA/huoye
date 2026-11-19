import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DevelopmentDirectories } from '../../src/plugin-packages/development-directory'
import { DevelopmentPackages } from '../../src/plugin-packages/development'
import { tempDir } from '../helpers/helpers'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => { const path = realpathSync(tempDir('rm-dev-directory-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path }
function source(parent: string, name: string, id = name) {
  const dir = join(parent, name); mkdirSync(dir)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, title: name, description: '目录测试', version: '1.0.0', author: 'test', apiVersion: 1, entries: { core: './core.ts' } }))
  writeFileSync(join(dir, 'core.ts'), `import type {CorePlugin} from '@resource-manager/plugin-api/core/contracts'; export const blocks=[]; export const plugin: CorePlugin={id:'${id}',version:1,blocks};`)
  return dir
}
function setup(data: string, roots: string[], toolchain: string | undefined = resolve('.')) {
  const packages = new DevelopmentPackages(data, ['file'])
  const directories = new DevelopmentDirectories(packages, data, { reserved: ['file'], executable: process.execPath, defaultToolchain: toolchain, changed() {} })
  cleanups.push(async () => { for (const root of roots) await directories.close(root) })
  return { packages, directories }
}
async function until(fn: () => boolean, label: string) {
  const deadline = Date.now() + 30000
  while (!fn()) { if (Date.now() > deadline) throw new Error(label); await new Promise(r => setTimeout(r, 100)) }
}

it('只发现直接子目录；新插件不自动启用，非法声明/重复身份/保留身份可见且不能启用', async () => {
  const data = temp(), root = temp(), other = temp(), folder = temp()
  source(folder, 'demo-first'); source(folder, 'demo-second', 'demo-first'); source(folder, 'reserved', 'file')
  const invalid = source(folder, 'demo-invalid'); writeFileSync(join(invalid, 'plugin.json'), '{')
  const nested = join(folder, 'nested'); mkdirSync(nested); source(nested, 'demo-nested')
  const { directories, packages } = setup(data, [root, other], '/missing-toolchain')
  await directories.setDirectory(root, folder)
  const state = directories.state(root)
  expect(state.rows).toHaveLength(4)
  expect(state.rows.every(r => r.problem && !r.availableHash && !r.appliedHash)).toBe(true)
  expect(state.problem).toContain('开发工具工程')
  expect(directories.state(other)).toEqual({ rows: [] })
  expect(packages.links(root)).toEqual([])
  expect(() => directories.apply(root, [{ source: invalid, hash: '0'.repeat(64) }])).toThrow()
  await directories.clear(root); expect(directories.state(root)).toEqual({ rows: [] })
})

it('自动构建并按仓库应用；同版本更新、失败、陈旧预览、移除、重开均保留明确选择', async () => {
  const data = temp(), root = temp(), other = temp(), folder = temp()
  const first = source(folder, 'demo-first'), second = source(folder, 'demo-second')
  const { directories, packages } = setup(data, [root, other])
  await directories.setDirectory(root, folder)
  expect(directories.state(root).rows.every(r => !r.availableHash)).toBe(true)
  await directories.prepare(root, [first, second])
  const rows = () => directories.state(root).rows
  const ready = () => rows().every(r => !!r.availableHash && r.build?.state === 'ready')
  await until(ready, '首次构建未就绪')
  const selection = () => rows().map(r => ({ source: r.source, hash: r.availableHash! }))
  const oldSelection = selection(); directories.apply(root, oldSelection)
  const oldLinks = packages.links(root)
  expect(oldLinks).toHaveLength(2)
  await directories.setDirectory(other, folder); await directories.prepare(other, [first])
  await until(() => !!directories.state(other).rows.find(r => r.source === first)?.availableHash, '第二仓库构建未就绪')
  const otherRow = directories.state(other).rows.find(r => r.source === first)!
  directories.apply(other, [{ source: first, hash: otherRow.availableHash! }])
  const otherHash = packages.links(other)[0].hash

  const code = readFileSync(join(first, 'core.ts'), 'utf8')
  writeFileSync(join(first, 'core.ts'), code.replace('version:1', 'version:2'))
  writeFileSync(join(second, 'core.ts'), 'const invalid: number = "bad"; export const blocks=[]; export const plugin = {}')
  await until(() => rows().some(r => r.source === second && r.build?.state === 'error') && rows().some(r => r.source === first && r.availableHash !== oldSelection.find(s => s.source === first)!.hash && !!r.availableHash), '错误或新构建未发现')
  expect(() => directories.apply(root, oldSelection)).toThrow()
  expect(packages.links(root)).toEqual(oldLinks)
  writeFileSync(join(second, 'core.ts'), `export const blocks=[];export const plugin={id:'demo-second',version:1,blocks}`)
  await until(ready, '修复后没有构建')
  expect(() => directories.apply(root, oldSelection)).toThrow('变化')
  directories.apply(root, selection())
  expect(packages.links(root).find(l => l.source === first)!.hash).not.toBe(otherHash)
  expect(packages.links(other)[0].hash).toBe(otherHash)
  expect(packages.links(root).every(l => l.manifest.version === '1.0.0')).toBe(true)

  // 停止/重新打开只启动监听，不应用未确认构建。
  const applied = packages.links(root)
  await directories.close(root)
  const reopened = setup(data, [root]).directories
  expect(reopened.state(root, true).rows.every(r => r.build?.state === 'stopped')).toBe(true)
  expect(reopened.state(root, true).rows.filter(r => r.appliedHash)).toHaveLength(2)
  expect(reopened.state(root).rows.filter(r => r.appliedHash)).toHaveLength(2)
  expect(packages.links(root)).toEqual(applied)
  await reopened.close(root)
  rmSync(second, { recursive: true })
  expect(directories.state(root).rows.find(r => r.source === second)?.problem).toContain('源码不在')
  directories.apply(root, [])
  expect(packages.links(root)).toEqual([])
  expect(packages.links(other)).toHaveLength(1)
  await directories.clear(root)
  expect(directories.state(root)).toEqual({ rows: [] })
}, 90000)

it('先勾选再补工具工程会继续构建；退出途中读取状态不重新启动监听', async () => {
  const data = temp(), root = temp(), folder = temp(), first = source(folder, 'demo-toolchain')
  const { directories, packages } = setup(data, [root], '/missing-toolchain')
  await directories.setDirectory(root, folder); await directories.prepare(root, [first])
  expect(directories.state(root).problem).toContain('开发工具工程')
  const changing = directories.setToolchain(root, resolve('.'))
  expect(directories.state(root).problem).toContain('正在更新')
  await changing
  await until(() => !!directories.state(root).rows[0]?.availableHash, '补充工具链后丢失勾选草稿')
  directories.apply(root, [{ source: first, hash: directories.state(root).rows[0].availableHash! }])
  // 快速退出再勾选，不让前一进程的 stopped 状态覆盖新进程的 ready。
  directories.apply(root, [])
  await directories.prepare(root, [first])
  await until(() => !!directories.state(root).rows[0]?.availableHash, '前一轮收尾覆盖了新构建')
  directories.apply(root, [{ source: first, hash: directories.state(root).rows[0].availableHash! }])
  const removing = directories.clear(root)
  expect(directories.state(root).problem).toContain('正在更新')
  await removing
  expect(packages.links(root)).toEqual([]); expect(directories.state(root)).toEqual({ rows: [] })
}, 45000)


it('多个来源去重，跨目录重复 ID 拒绝；移除已失联来源不影响其余来源', async () => {
  const data=temp(), root=temp(), a=temp(), b=temp(), one=source(a,'demo-one')
  source(b,'demo-two')
  const {directories}=setup(data,[root],'/missing-toolchain')
  await directories.addDirectory(root,a);await directories.addDirectory(root,one);await directories.addDirectory(root,b)
  expect(directories.state(root).rows.map(r=>r.id)).toEqual(['demo-one','demo-two'])
  source(b,'duplicate','demo-one')
  expect(directories.state(root).rows.filter(r=>r.id==='demo-one').every(r=>!!r.problem)).toBe(true)
  rmSync(a,{recursive:true})
  await directories.removeDirectory(root,a);await directories.removeDirectory(root,one)
  expect(directories.state(root).directories).toEqual([b])
  expect(directories.state(root).rows).toHaveLength(2)
})
