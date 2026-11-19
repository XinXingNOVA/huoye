import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generatePlugins, pluginExecutables } from '../../scripts/plugins/generate'
import { catalogBlocks, catalogEntries } from '../../src/shared/plugin-catalog'
import { enabledPlugins, selectContributions, validatePlugins, type PluginInfo } from '../../src/shared/plugin-plan'
import { validateUiContributions } from '../../src/shared/ui-contributions'
import { Registry } from '../../src/core/registry'
import type { CorePlugin } from '../../src/core/plugin'
import { PLUGINS, resolvePlugins } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { entries as schemas } from '../../src/plugins/generated/blocks'
import { openHost } from '../helpers/helpers'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const info = (id: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({ id, title: id, description: id, ...extra })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rm-catalog-test-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const add = (id: string, entries: Record<string, string>, extra: Partial<PluginInfo> = {}) => {
    const dir = join(root, 'src/plugins', id)
    mkdirSync(dir, { recursive: true })
    const descriptor = { ...info(id, extra), entries }
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(descriptor))
    for (const [side, path] of Object.entries(entries)) {
      writeFileSync(join(dir, path), side === 'blocks' ? 'export const blocks = []' : `export const plugin = { id: '${id}' }`)
    }
    return dir
  }
  return { root, add }
}

describe('插件目录生成', () => {
  it('静态校验合并附带包依赖；发行策略独立生成且不导入包业务', () => {
    const { root, add } = fixture()
    add('consumer', { core: './core.ts' }, { requires: ['note'] })
    const dir = join(root, 'packaging/plugins/note'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'note', title: '笔记', description: '', entries: { core: './core.ts' } }))
    writeFileSync(join(dir, 'distribution.json'), JSON.stringify({ group: 'common', defaultEnabled: true, legacyBuiltin: true }))
    generatePlugins(root)
    const policy = readFileSync(join(root, 'src/plugins/generated/distribution.ts'), 'utf8')
    expect(policy).toContain('legacyBuiltin')
    expect(readFileSync(join(root, 'src/plugins/generated/core.ts'), 'utf8')).not.toContain('note/core')
    writeFileSync(join(dir, 'distribution.json'), JSON.stringify({ group: 'base', defaultEnabled: true }))
    expect(() => generatePlugins(root)).toThrow('发行策略无效')
    rmSync(dir, { recursive: true })
    expect(() => generatePlugins(root)).toThrow('note')
  })

  it('应用入口单独生成，不进入仓库清单；拒绝应用数据块及跨域依赖', () => {
    const { root, add } = fixture()
    add('app-access', { service: './service.ts', ui: './ui.ts' }, { scope: 'application' })
    add('library-ui', { ui: './ui.ts' })
    generatePlugins(root)
    expect(readFileSync(join(root, 'src/plugins/generated/service.ts'), 'utf8')).not.toContain('../app-access/')
    expect(readFileSync(join(root, 'src/plugins/generated/ui.ts'), 'utf8')).not.toContain('../app-access/')
    expect(readFileSync(join(root, 'src/plugins/generated/application-service.ts'), 'utf8')).toContain('../app-access/service.ts')
    expect(readFileSync(join(root, 'src/plugins/generated/application-ui.ts'), 'utf8')).toContain('ApplicationUiPlugin')
    expect(() => validatePlugins([info('a', { scope: 'application', requires: ['b'] }), info('b')])).toThrow('跨作用域')
    add('bad', { core: './core.ts', blocks: './blocks.ts' }, { scope: 'application' })
    expect(() => generatePlugins(root)).toThrow('不能注册仓库数据块')
  })

  it('仅添加服务目录即可登记设置、服务和独立构建入口，首次生成即可构建', () => {
    const { root, add } = fixture()
    const dir = add('access', { service: './service.ts', ui: './ui.ts' }, { executables: { bridge: './stdio.ts' } })
    writeFileSync(join(dir, 'stdio.ts'), "import { readFileSync } from 'node:fs'\nimport type { Server } from '@modelcontextprotocol/sdk/server/index.js'\nexport {}")
    generatePlugins(root)
    expect(pluginExecutables(root)).toEqual([{ id: 'access', name: 'bridge', source: 'src/plugins/access/stdio.ts' }])
    expect(readFileSync(join(root, 'src/plugins/generated/service.ts'), 'utf8')).toContain('../access/service.ts')
    expect(readFileSync(join(root, 'src/plugins/generated/executables.ts'), 'utf8')).toContain('typeof import("../access/stdio.ts")')
    expect(() => generatePlugins(root, true)).not.toThrow()
    // UI 不能把服务入口或其协议依赖偷偷带进浏览器。
    writeFileSync(join(dir, 'ui.ts'), "import './service'\nexport const plugin = { id: 'access' }")
    expect(() => generatePlugins(root)).toThrow(/核心代码/)
  })

  it.each(['index', 'core', '../bad'])('拒绝独立入口保留名称／越界名称 %s', name => {
    const { root, add } = fixture()
    const dir = add('access', { service: './service.ts' }, { executables: { [name]: './stdio.ts' } })
    writeFileSync(join(dir, 'stdio.ts'), 'export {}')
    expect(() => generatePlugins(root)).toThrow(/独立入口/)
  })

  it('拒绝独立入口重名，以及服务通过辅助文件访问宿主内部', () => {
    const { root, add } = fixture()
    for (const id of ['one', 'two']) {
      const dir = add(id, { service: './service.ts' }, { executables: { bridge: './stdio.ts' } })
      writeFileSync(join(dir, 'stdio.ts'), 'export {}')
    }
    expect(() => generatePlugins(root)).toThrow(/名称重复/)
    rmSync(join(root, 'src/plugins/two'), { recursive: true })
    const main = join(root, 'src/main')
    mkdirSync(main); writeFileSync(join(main, 'private.ts'), 'export type Secret = string')
    const dir = join(root, 'src/plugins/one')
    writeFileSync(join(dir, 'helper.ts'), "export type { Secret } from '../../main/private'")
    writeFileSync(join(dir, 'service.ts'), "import './helper'\nexport const plugin = { id: 'one' }")
    expect(() => generatePlugins(root)).toThrow(/后端边界.*宿主内部/)
  })
  it('只添加目录就发现 UI、核心与共同定义；稳定排序，生成结果不变时不重写', () => {
    const { root, add } = fixture()
    add('zeta', { ui: './ui.tsx' }, { order: 1 })
    add('alpha', { core: './core.ts', blocks: './blocks.ts' }, { order: 2 })
    expect(generatePlugins(root)).toHaveLength(9)
    const file = join(root, 'src/plugins/generated/manifest.ts')
    const stamp = statSync(file).mtimeMs
    expect(generatePlugins(root, true)).toEqual([])
    expect(generatePlugins(root)).toEqual([])
    expect(statSync(file).mtimeMs).toBe(stamp)
    expect(readFileSync(join(root, 'src/plugins/generated/ui.ts'), 'utf8')).toContain('../zeta/ui.tsx')
    const manifest = readFileSync(file, 'utf8')
    expect(manifest.indexOf('zeta')).toBeLessThan(manifest.indexOf('alpha'))
    expect(readFileSync(join(root, 'src/plugins/generated/ui.ts'), 'utf8')).not.toContain('../alpha/core')
    add('beta', { ui: './ui.ts' })
    expect(() => generatePlugins(root, true)).toThrow(/已过期/)
    expect(readFileSync(file, 'utf8')).toBe(manifest)
    generatePlugins(root)
    expect(readFileSync(file, 'utf8')).toContain('beta')
  })

  it('指南的示例可以直接复制发现，无须修改集中名单', () => {
    const { root, add } = fixture()
    add('table', { ui: './ui.ts' })
    cpSync(resolve('examples/reviewmemo'), join(root, 'src/plugins/reviewmemo'), { recursive: true })
    generatePlugins(root)
    expect(readFileSync(join(root, 'src/plugins/generated/core.ts'), 'utf8')).toContain('../reviewmemo/core')
    expect(readFileSync(join(root, 'src/plugins/generated/blocks.ts'), 'utf8')).toContain('../reviewmemo/blocks')
  })

  it.each(['missing', 'export', 'outside', 'typo', 'owner'] as const)('声明错误在写生成文件之前失败：%s', (issue) => {
    const { root, add } = fixture()
    const dir = add('broken', { core: './core.ts' })
    if (issue === 'missing') rmSync(join(dir, 'core.ts'))
    if (issue === 'export') writeFileSync(join(dir, 'core.ts'), 'export const wrong = {}')
    if (issue === 'outside') writeFileSync(join(dir, 'plugin.json'), JSON.stringify(info('broken', { entries: { core: './../bad.ts' } })))
    if (issue === 'typo') writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...info('broken'), entry: {} }))
    if (issue === 'owner') {
      writeFileSync(join(dir, 'core.ts'), 'export const blocks = []')
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify(info('broken', { entries: { blocks: './core.ts' } })))
    }
    expect(() => generatePlugins(root)).toThrow()
  })

  it.each(['node:fs', 'fs/promises', 'better-sqlite3', 'sharp', 'electron'])('阻止浏览器入口间接导入 %s，允许同名类型引用', (name) => {
    const { root, add } = fixture()
    const dir = add('browser', { ui: './ui.ts' })
    writeFileSync(join(dir, 'ui.ts'), "import './helper'\nexport const plugin = { id: 'browser' }")
    writeFileSync(join(dir, 'helper.ts'), `import type { Any } from '${name}'\nexport type { Any }`)
    expect(() => generatePlugins(root)).not.toThrow()
    writeFileSync(join(dir, 'helper.ts'), `export { default } from '${name}'`)
    expect(() => generatePlugins(root)).toThrow(/browser.*helper.*核心|核心模块.*helper/)
  })

  it('不允许 UI 通过普通相对路径引用核心入口或核心实现目录', () => {
    const { root, add } = fixture()
    const dir = add('mixed', { ui: './ui.ts', core: './core.ts' })
    writeFileSync(join(dir, 'ui.ts'), "import './core'\nexport const plugin = { id: 'mixed' }")
    expect(() => generatePlugins(root)).toThrow(/核心代码.*core/)
  })
})

describe('完整登记与装配诊断', () => {
  it('拒绝重复 ID、缺失依赖、必需依赖环；可选互相协作不会构成启用环', () => {
    expect(() => validatePlugins([info('a'), info('a')])).toThrow(/重复/)
    expect(() => validatePlugins([info('a', { optional: ['missing'] })])).toThrow(/missing/)
    expect(() => validatePlugins([info('a', { requires: ['b'] }), info('b', { requires: ['a'] })])).toThrow(/a → b → a/)
    expect(() => validatePlugins([info('a', { optional: ['b'] }), info('b', { optional: ['a'] })])).not.toThrow()
    expect(() => validatePlugins([info('a', { required: true, requires: ['b'] }), info('b')])).toThrow(/必需插件/)
    expect(resolvePlugins(['a'], [info('a'), info('b', { requires: ['a'] })]).off.get('b')).toBe('需要「a」')
  })

  it('入口 ID 和静态定义归属需要一致，整个核心与浏览器共用同一组定义', () => {
    expect(() => catalogEntries([info('a', { entries: { core: './core.ts' } })], 'core', [{ id: 'a', plugin: { id: 'wrong' } }])).toThrow(/wrong/)
    expect(() => catalogEntries([info('a', { entries: { core: './core.ts' } })], 'core', [])).toThrow(/清单/)
    const all = catalogBlocks(PLUGINS, schemas)
    expect(all.map((b) => b.id)).toEqual(corePlugins.flatMap((p) => p.blocks ?? []).map((b) => b.id))
    for (const p of corePlugins) expect(p.blocks).toBe(schemas.find((s) => s.id === p.id)?.blocks)
    expect(all.find((b) => b.id === 'view')).toMatchObject({ standalone: true })
    expect(() => catalogBlocks(PLUGINS, schemas.map((s) => s.id === 'file' ? { ...s, blocks: [...s.blocks, ...s.blocks] } : s))).toThrow(/重复/)
    expect(() => catalogBlocks(PLUGINS, schemas.map((s) => s.id === 'file' ? { ...s, blocks: [{ ...s.blocks[0], plugin: 'wrong' }] } : s))).toThrow(/归属/)
  })

  it('核心 System 和识别器重名即使 needs 未满足也会被发现', () => {
    const system = corePlugins.find((p) => p.id === 'text')!.systems![0]
    const recognizer = corePlugins.find((p) => p.id === 'text')!.recognizers![0]
    for (const key of ['systems', 'recognizers'] as const) {
      const value = key === 'systems' ? { ...system, needs: ['missing'] } : recognizer
      const p = { id: 'fake', version: 1, [key]: [value, value] } as CorePlugin
      expect(() => new Registry([p])).toThrow(/ID 重复/)
    }
  })

  it.each(['settingsSections', 'layouts', 'tabTypes', 'actions', 'creates', 'sections', 'blockSections', 'navs', 'overlays', 'views'])('界面 %s 重名包含宿主冲突，不允许覆盖', (key) => {
    expect(() => validateUiContributions([{ id: 'host', [key]: [{ id: 'same' }] }, { id: 'test', [key]: [{ id: 'same' }] }], [info('test')])).toThrow(/same.*host.*test/)
  })

  it('逐块详情的匹配优先级和默认位置必须是有限值，可选依赖仍由宿主筛选', () => {
    const section = { id: 'test.block', order: 40, priority: 10, needs: ['table'] }
    const plugin = { id: 'test', blockSections: [section] }
    const manifest = [info('test', { optional: ['table'] }), info('table')]
    expect(() => validateUiContributions([plugin], manifest)).not.toThrow()
    expect(selectContributions([plugin], new Set(['test']))[0].blockSections).toEqual([])
    for (const bad of [{ order: NaN }, { priority: Infinity }]) {
      expect(() => validateUiContributions([{ ...plugin, blockSections: [{ ...section, ...bad }] }], manifest)).toThrow(/order/)
    }
  })

  it('核心状态可序列化且重载后才改变；界面不启用未知插件', async () => {
    const a = openHost(corePlugins, { manifest: PLUGINS })
    cleanups.push(a.cleanup)
    await a.host.api.setPlugins(['preview'])
    const before = (await a.host.api.info()).assembly
    expect(enabledPlugins(before, PLUGINS).has('image')).toBe(true)
    a.host.close()
    cleanups.pop()
    const b = openHost(corePlugins, { manifest: PLUGINS }, a.root)
    cleanups.push(b.cleanup)
    const after = JSON.parse(JSON.stringify((await b.host.api.info()).assembly))
    expect(after.plugins.find((p: { id: string }) => p.id === 'preview')).toMatchObject({ chosen: true, enabled: false })
    expect(after.plugins.find((p: { id: string }) => p.id === 'image')).toMatchObject({ chosen: false, enabled: false, reason: '需要「预览」' })
    expect(enabledPlugins(after, PLUGINS).has('image')).toBe(false)
    expect(() => enabledPlugins({ plugins: [] }, PLUGINS)).toThrow(/不一致/)
  })

  it('缺少外部程序只报告加工不可用，不撤下插件定义与装配状态', async () => {
    const p: CorePlugin = { id: 'probe', version: 1, requires: { programs: ['rm-test-nonexistent-binary-4567'] } }
    const h = openHost([p], { manifest: [info('probe')] })
    cleanups.push(h.cleanup)
    expect((await h.host.api.info()).assembly.plugins[0]).toMatchObject({ id: 'probe', enabled: true, unavailable: '找不到 rm-test-nonexistent-binary-4567' })
    expect((await h.host.api.plugins())[0]).toMatchObject({ enabled: true })
  })
})
