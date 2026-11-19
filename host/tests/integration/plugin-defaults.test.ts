import { pluginSource } from '../helpers/plugin-sources'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packPlugin } from '../../scripts/plugins/pack'
import { PackageManager } from '../../src/plugin-packages/manager'
import { adoptBundledPlugins, loadExternalCore, readBindings, readDisabled } from '../../src/core/external-plugins'
import { initializePluginDefaults } from '../../src/core/plugin-defaults'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { PLUGINS } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import { resolvePluginPlan, validatePlugins } from '../../src/shared/plugin-plan'
import { legacyCorePlugins, legacyManifest } from '../helpers/legacy-plugins'
import { tempDir } from '../helpers/helpers'

const roots: string[] = [], hosts: Host[] = []
const temp = () => { const dir = tempDir('rm-defaults-'); roots.push(dir); return dir }
let bytes: Buffer[], build: string
beforeAll(async () => {
  build = tempDir('rm-note-source-packs-')
  bytes = await Promise.all(['note', 'source', 'status', 'kanban', 'tags', 'table', 'fields', 'annotate'].map(async id => {
    cpSync(pluginSource(id), join(build, id), { recursive: true })
    await packPlugin(join(build, id), join(build, `${id}.rmplugin`))
    return readFileSync(join(build, `${id}.rmplugin`))
  }))
}, 60000)
afterEach(() => { hosts.splice(0).forEach(h => { if (h.lib.db.open) h.close() }); roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
afterAll(() => rmSync(build, { recursive: true, force: true }))
const manager = (user = temp()) => { const m = new PackageManager(user, PLUGINS.map(p => p.id)); m.provisionBundled(bytes); return m }
async function start(root: string, m: PackageManager) {
  const lib = openLibrary(root)
  try {
    adoptBundledPlugins(lib, m.bundled(), PLUGINS, DISTRIBUTION)
    const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, m.begin(root), DISTRIBUTION)
    const host = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
    hosts.push(host); m.ready(root); await host.scheduler.idle(); return host
  } catch (e) { if (lib.db.open) lib.close(); throw e }
}
async function old(root: string, disabled: string[] = []) {
  const h = new Host(root, legacyCorePlugins, () => {}, { manifest: legacyManifest })
  try {
    h.lib.db.prepare("DELETE FROM main.meta WHERE key='plugin_defaults_pending'").run()
    const [id] = await h.api.ingest([{ type: 'text', text: '旧笔记正文', source: { url: 'https://www.example.com/old', title: '旧网页' } }])
    h.api.put(id, 'note', { text: '迁移保留的想法' }); h.api.setPlugins(disabled); await h.scheduler.idle()
    return { id, record: h.store.get([id])[0], history: h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all() }
  } finally { h.close() }
}

it('新仓库标准组合；笔记来源从项目外打包加载，正文收录、来源去重、笔记搜索与导出仍工作', async () => {
  const root = temp(), m = manager(), lib = openLibrary(root); lib.close() // 应用先建库，再由核心装配。
  const h = await start(root, m)
  expect(PLUGINS.some(p => ['note', 'source'].includes(p.id))).toBe(false)
  for (const id of ['file', 'view', 'image', 'preview', 'audio', 'video', 'pdf', 'text', 'tags', 'note', 'source']) expect(h.plan.enabled.has(id), id).toBe(true)
  for (const id of ['fields', 'table', 'annotate', 'status', 'kanban']) expect(h.plan.enabled.has(id), id).toBe(false)
  const source = join(temp(), '新素材.txt'); writeFileSync(source, '新文件正文 保留原字节')
  const [id] = await h.api.ingest([{ type: 'file', path: source, source: { url: 'https://www.example.com/book', title: '书籍' } }]); await h.scheduler.idle()
  const before = h.store.blocksOf(id).source
  expect(before.data).toEqual({ url: 'https://www.example.com/book', title: '书籍', site: 'example.com' })
  await h.api.ingest([{ type: 'file', path: source, source: { url: 'https://elsewhere.com' } }])
  expect(h.store.blocksOf(id).source).toEqual(before)
  h.api.put(id, 'note', { text: '包内笔记 needle' })
  expect((await h.api.searchPage({ query: { search: [{ kind: 'note', field: 'text', text: 'needle' }] } })).items[0].id).toBe(id)
  expect((await h.api.readContent({ id, kind: 'note', field: 'text' })).text).toContain('needle')
  const output = await h.api.exportRun({ ids: [id], titles: {}, parent: temp(), name: '笔记导出' })
  expect(output.failed).toEqual([])
  expect(readFileSync(join(output.dir, '索引.md'), 'utf8')).toContain('包内笔记 needle')
  expect(readFileSync(await h.api.locateOriginalFile({ id, kind: 'file', field: 'path' })) ).toEqual(readFileSync(source))
})

it.each([[], ['note'], ['source'], ['note', 'source', 'preview']].map(disabled => ({ disabled })))('旧仓库 %j：开关、块序号、历史不变；内置依赖按实际外部包解析', async ({ disabled }) => {
  const root = temp(), before = await old(root, disabled), m = manager()
  const h = await start(root, m)
  expect(h.store.get([before.id])[0]).toEqual(before.record)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
  for (const id of ['note','source']) expect(h.plan.enabled.has(id)).toBe(!disabled.includes(id))
  expect(h.plan.enabled.has('annotate')).toBe(!disabled.includes('note') && !disabled.includes('preview'))
  expect(h.plan.enabled.has('fields')).toBe(true)
  expect(h.plan.enabled.has('status')).toBe(true)
  const config = h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
  adoptBundledPlugins(h.lib, m.bundled(), PLUGINS, DISTRIBUTION)
  expect(h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(config)
})

it('统一停用并卸载来源和笔记，旧数据只读；基础文件导入继续，重装需明确启用', async () => {
  const root = temp(), before = await old(root), user = temp(), m = manager(user)
  let h = await start(root, m)
  const refs = readBindings(h.lib).filter(p => ['note','source'].includes(p.manifest.id))
  h.api.setPluginSettings(['fields'], refs.map(p => ({ ...p, enabled: false })))
  expect(h.plan.enabled.has('note')).toBe(true)
  h.close()
  for (const ref of refs) m.uninstall(ref.hash)
  const restarted = manager(user); h = await start(root, restarted)
  expect(restarted.list().some(p => ['note','source'].includes(p.manifest.id))).toBe(false)
  expect(h.plan.enabled.has('annotate')).toBe(false)
  expect(h.store.get([before.id])[0]).toEqual(before.record)
  expect(h.reg.kind('note')?.dormant).toBe(true)
  expect(() => h.api.patch(before.id, 'note', { text: '不能写入' })).toThrow('没有启用')
  const source = join(temp(), '卸载后.txt'); writeFileSync(source, '仍可收录')
  const [id] = await h.api.ingest([{ type: 'file', path: source }]); await h.scheduler.idle(); expect(h.store.blocksOf(id).file).toBeTruthy()
  for (const buffer of bytes.slice(0,2)) restarted.install(buffer)
  h.close(); h = await start(root, restarted)
  expect(h.plan.enabled.has('note')).toBe(false)
  for (const ref of refs) restarted.grant(root, ref.hash)
  h.api.setPluginSettings(readDisabled(h.lib), refs.map(p => ({ ...p, enabled: true })))
  h.close(); h = await start(root, restarted)
  h.api.patch(before.id, 'note', { text: '恢复编辑' }); h.api.undo()
  expect(h.store.blocksOf(before.id).note.data.text).toBe('迁移保留的想法')
  expect(h.store.blocksOf(before.id).source).toEqual(before.record.blocks.source)
})

it('默认规则更新不重设选择，新加入的内置功能在既有仓库保持关闭', () => {
  const lib = openLibrary(temp())
  try {
    initializePluginDefaults(lib, PLUGINS, DISTRIBUTION)
    const before = readDisabled(lib)
    initializePluginDefaults(lib, PLUGINS, DISTRIBUTION.map(p => ({ ...p, defaultEnabled: !p.defaultEnabled })))
    expect(readDisabled(lib)).toEqual(before)
    initializePluginDefaults(lib, [...PLUGINS, { id: 'future', title: '未来功能', description: '' }], DISTRIBUTION)
    expect(readDisabled(lib)).toEqual([...before, 'future'])
  } finally { lib.close() }
})

it('运行时内外缺依赖同样降级；静态发行检查仍拒绝拼错的依赖，基础模块不能依赖可卸载能力', () => {
  const a = { id: 'a', title: 'A', description: '', requires: ['missing'] }
  expect(resolvePluginPlan([], [a]).off.get('a')).toContain('缺少依赖')
  expect(resolvePluginPlan([], [{ ...a, requires: [], optional: ['missing'] }]).enabled.has('a')).toBe(true)
  expect(() => validatePlugins([a])).toThrow('missing')
  expect(() => resolvePluginPlan([], [{ ...a, required: true }])).toThrow('必需插件')
})

// 测试模式生成旧版本样本；不使用新的插件定义。
it.skipIf(!process.env.DEFAULTS_LEGACY_DIR)('生成 Electron 笔记来源旧库样本', async () => {
  const dir = resolve(process.env.DEFAULTS_LEGACY_DIR!)
  mkdirSync(dir, { recursive: true })
  const enabled = await old(join(dir, 'library'))
  const disabled = await old(join(dir, 'disabled-library'), ['note','source'])
  writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ enabled, disabled }))
})
