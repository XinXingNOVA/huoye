import { pluginSource } from '../helpers/plugin-sources'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packPlugin } from '../../scripts/plugins/pack'
import { decodePackage, encodePackage } from '../../src/plugin-packages/archive'
import { PackageManager } from '../../src/plugin-packages/manager'
import { adoptBundledPlugins, loadExternalCore, readBindings, readDisabled, setBinding } from '../../src/core/external-plugins'
import { openLibrary } from '../../src/core/library'
import { Host } from '../../src/core/host'
import { PLUGINS } from '../../src/plugins/manifest'
import { corePlugins } from '../../src/plugins/core'
import { DISTRIBUTION } from '../../src/plugins/generated/distribution'
import { canonical, kindSnapshot, type PackageManifest } from '../../src/shared/external-plugins'
import { seedTagsTable } from '../fixtures/tags-table-fixture'
import { tempDir } from '../helpers/helpers'

const roots: string[] = [], hosts: Host[] = []
const temp = () => { const dir = tempDir('rm-fields-'); roots.push(dir); return dir }
let bytes: Buffer, build: string
beforeAll(async () => {
  build = tempDir('rm-fields-pack-')
  cpSync(pluginSource("fields"), join(build, 'source'), { recursive: true })
  await packPlugin(join(build, 'source'), join(build, 'fields.rmplugin'))
  bytes = readFileSync(join(build, 'fields.rmplugin'))
  rmSync(join(build, 'source'), { recursive: true })
}, 60000)
afterAll(() => rmSync(build, { recursive: true, force: true }))
afterEach(() => { hosts.splice(0).forEach(h => { if (h.lib.db.open) h.close() }); roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const manager = (user = temp()) => { const m = new PackageManager(user, PLUGINS.map(p => p.id)); m.provisionBundled([bytes]); return m }
async function start(root: string, m: PackageManager) {
  const lib = openLibrary(root)
  try {
    adoptBundledPlugins(lib, m.bundled(), PLUGINS, DISTRIBUTION)
    const assembly = await loadExternalCore(lib, PLUGINS, corePlugins, m.begin(root), DISTRIBUTION)
    const h = new Host(root, assembly.plugins, () => {}, { library: lib, manifest: assembly.manifest })
    hosts.push(h); m.ready(root); await h.scheduler.idle(); return h
  } catch (e) { if (lib.db.open) lib.close(); throw e }
}
function variant(code: string, manifest?: (m: PackageManifest) => void) {
  const p = decodePackage(bytes)
  p.manifest.version = '2.0.0'; manifest?.(p.manifest)
  p.files.set('core.mjs', Buffer.from(p.files.get('core.mjs')!.toString() + '\nconst plugin = fieldsPlugin;\n' + code))
  return encodePackage(p.manifest, p.files)
}
function update(root: string, m: PackageManager, buffer: Buffer) {
  const ref = m.install(buffer); m.grant(root, ref.hash)
  const lib = openLibrary(root)
  try { setBinding(lib, { ...ref, enabled: true }, PLUGINS) } finally { lib.close() }
}

it.each([false,true].flatMap(registered => [[],['fields']].map(disabled => ({ registered, disabled }))))('旧库 $registered / $disabled：模板、值、历史及原选择完整交接', async ({ registered, disabled }) => {
  const root = temp(), before = await seedTagsTable(root, disabled, registered), m = manager(), h = await start(root, m)
  expect(PLUGINS.some(p => p.id === 'fields')).toBe(false)
  expect(decodePackage(bytes).files.get('ui.css')!.toString()).toContain('.template-head')
  expect(h.store.get(before.ids)).toEqual(before.records)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
  expect(h.plan.enabled.has('fields')).toBe(!disabled.includes('fields'))
  expect(!!h.reg.kind(before.kind)?.dormant).toBe(disabled.includes('fields'))
  expect((await h.api.query({ search: [{ kind: before.kind, field: 'fyear', text: '2026' }] })).ids).toEqual([before.id])
  const config = h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()
  adoptBundledPlugins(h.lib, m.bundled(), PLUGINS, DISTRIBUTION)
  expect(h.lib.db.prepare('SELECT * FROM main.config ORDER BY key').all()).toEqual(config)
})

it('外部字段转换预演、删除含回收站的模板及整批撤销重做；重开使用最新定义', async () => {
  const root = temp(), before = await seedTagsTable(root), m = manager(); let h = await start(root, m)
  const source = join(temp(), '新的文件.txt'); writeFileSync(source, '字段新素材')
  const [id] = await h.api.ingest([{ type: 'file', path: source }]); await h.scheduler.idle()
  h.api.put(id, before.kind, { fyear: '2025' }); h.api.trash([id])
  const args = { template: before.template, field: 'fyear', type: 'number' }
  const records = h.store.get([...before.ids, id])
  h.api.preview('fields', 'changeType', args)
  expect(h.store.get([...before.ids, id])).toEqual(records)
  expect(h.reg.kind(before.kind)?.fields.fyear.type).toBe('text')
  h.api.run('fields', 'changeType', args)
  expect(h.store.blocksOf(id)[before.kind].data.fyear).toBe(2025)
  h.api.undo(); expect(h.store.blocksOf(id)[before.kind].data.fyear).toBe('2025')
  h.api.redo(); expect(h.reg.kind(before.kind)?.fields.fyear.type).toBe('number')
  h.api.run('fields', 'deleteTemplate', { template: before.template, expectedAffected: 2 })
  expect(h.store.exists(before.template)).toBe(false)
  expect(h.store.blocksOf(id)[before.kind]).toBeUndefined()
  expect(h.lib.db.prepare('SELECT 1 FROM main.kind_def WHERE id = ?').get(before.kind)).toBeUndefined()
  h.api.undo()
  expect(h.reg.kind(before.kind)?.fields.fyear.type).toBe('number')
  expect(h.lib.db.prepare('SELECT 1 FROM main.kind_def WHERE id = ?').get(before.kind)).toBeDefined()
  expect(h.store.blocksOf(id)[before.kind].data.fyear).toBe(2025)
  h.close(); h = await start(root, m)
  expect(h.plan.enabled.has('fields')).toBe(true)
  expect(h.reg.kind(before.kind)?.fields.fyear.type).toBe('number')
})

it('停用卸载重启后保留只读模板和值，重装不擅自启用；手动启用恢复编辑', async () => {
  const root = temp(), user = temp(), before = await seedTagsTable(root), m = manager(user); let h = await start(root, m)
  const [ref] = readBindings(h.lib)
  h.api.setPluginSettings(readDisabled(h.lib), [{ ...ref, enabled: false }]); h.close(); m.uninstall(ref.hash)
  const restarted = manager(user); h = await start(root, restarted)
  expect(restarted.list()).toHaveLength(0)
  expect(h.store.get(before.ids)).toEqual(before.records)
  expect(h.reg.kind(before.kind)?.dormant).toBe(true)
  expect(() => h.api.patch(before.id, before.kind, { fyear: '2027' })).toThrow('没有启用')
  expect((await h.api.readContent({ id: before.id, kind: before.kind, field: 'fyear' })).text).toBe('2026')
  restarted.install(bytes); h.close(); h = await start(root, restarted)
  expect(h.plan.enabled.has('fields')).toBe(false)
  restarted.grant(root, ref.hash)
  h.api.setPluginSettings(readDisabled(h.lib), [{ ...ref, enabled: true }]); h.close(); h = await start(root, restarted)
  h.api.run('fields', 'renameTemplate', { template: before.template, title: '恢复编辑' }); h.api.undo()
  expect(h.store.blocksOf(before.template).template.data.title).toBe('参考信息')
})

it('拒绝插件升级重新解释已有字段，旧快照继续只读且原数据与历史不变', async () => {
  const root = temp(), before = await seedTagsTable(root), m = manager(); let h = await start(root, m)
  const snapshot = kindSnapshot(h.reg.kind(before.kind)!)
  h.close()
  update(root, m, variant('const original = plugin.defines.build; plugin.defines.build = (id,data) => { const k = original(id,data); k.fields.fyear.type = "number"; delete k.fields.fyear.search; return k }'))
  h = await start(root, m)
  expect(h.plan.enabled.has('fields')).toBe(false)
  expect(h.plan.off.get('fields')).toContain('动态数据定义与插件包不兼容')
  expect(h.reg.kind(before.kind)?.dormant).toBe(true)
  expect(canonical(kindSnapshot(h.reg.kind(before.kind)!))).toBe(canonical(snapshot))
  expect(h.store.get(before.ids)).toEqual(before.records)
  expect(h.lib.db.prepare('SELECT * FROM main.block_history ORDER BY seq').all()).toEqual([])
})

it.each([
  'k.id = "note"', 'k.plugin = "text"', 'k.template = "other"', 'k.fields.bad = {type:"invalid",title:"坏字段"}',
  'k.fields.bad = {type:"text",title:"原文件",file:true}', 'k.rebuildable = true', 'k.version = 2'
])('运行时拒绝非法定义 %s，独立写入及命令均回滚数据、索引、快照和内存定义', async invalid => {
  const root = temp(), before = await seedTagsTable(root), m = manager()
  let h = await start(root, m); h.close()
  update(root, m, variant(`const original = plugin.defines.build; plugin.defines.build = (id,data) => { const k = original(id,data); if(data.title === "坏模板") { ${invalid}; } return k }`))
  h = await start(root, m); expect(h.plan.enabled.has('fields')).toBe(true)
  const snapshot = () => ['block','field_index','kind_def','block_history','meta'].map(table => h.lib.db.prepare(`SELECT * FROM main.${table}`).all())
  const saved = snapshot(), def = canonical(kindSnapshot(h.reg.kind(before.kind)!))
  expect(() => h.store.put(before.template, 'template', { ...h.store.blocksOf(before.template).template.data, title: '坏模板' })).toThrow()
  expect(snapshot()).toEqual(saved)
  expect(() => h.api.run('fields', 'renameTemplate', { template: before.template, title: '坏模板' })).toThrow()
  expect(snapshot()).toEqual(saved)
  expect(canonical(kindSnapshot(h.reg.kind(before.kind)!))).toBe(def)
  h.api.run('fields', 'renameTemplate', { template: before.template, title: '正常模板' })
  h.api.undo(); expect(h.store.blocksOf(before.template).template.data.title).toBe('参考信息')
})

it.each(['undeclared','foreign-prefix','changed-source','removed-provider'])('拒绝缺失或变更的定义契约：%s', async mode => {
  const root = temp(), m = manager(); let h = await start(root, m)
  const [ref] = readBindings(h.lib); h.api.setPluginSettings(readDisabled(h.lib), [{ ...ref, enabled: true }]); h.close()
  h = await start(root, m); h.close() // 空仓库也锁定契约。
  const code = mode === 'removed-provider' ? 'delete plugin.defines' : mode === 'foreign-prefix' ? 'plugin.defines.prefix = "note:"' : mode === 'changed-source' ? 'plugin.defines.kind = "missing"' : ''
  update(root, m, variant(code, manifest => {
    if (mode === 'removed-provider' || mode === 'undeclared') delete manifest.definitions
    if (mode === 'foreign-prefix') manifest.definitions!.prefix = 'note:'
    if (mode === 'changed-source') manifest.definitions!.kind = 'missing'
  }))
  h = await start(root, m); expect(h.plan.enabled.has('fields')).toBe(false)
})

it('删除模板后回收动态快照，重开不复活；原素材和无关数据仍保留', async () => {
  const root = temp(), before = await seedTagsTable(root), m = manager(); let h = await start(root, m)
  h.api.run('fields', 'deleteTemplate', { template: before.template, expectedAffected: 1 }); h.close()
  h = await start(root, m)
  expect(h.plan.enabled.has('fields')).toBe(true)
  expect(h.reg.kind(before.kind)).toBeUndefined()
  expect(h.lib.db.prepare('SELECT 1 FROM main.kind_def WHERE id = ?').get(before.kind)).toBeUndefined()
  expect(h.store.blocksOf(before.id).text).toEqual(before.records[0].blocks.text)
})

it.each(['demo', 'tpl'])('普通包的动态命名空间：%s（拒绝占用旧前缀）', async id => {
  const root = temp(), m = manager()
  const manifest: PackageManifest = { formatVersion: 1, apiVersion: 1, id, title: id, description: '', author: 'test', version: '1.0.0', requires: [], optional: [], styles: [], entries: { core: 'core.mjs' }, definitions: { kind: `${id}-schema`, prefix: `${id}:` } }
  const code = `export const blocks = [{id:'${id}-schema',plugin:'${id}',title:'定义',rebuildable:false,standalone:true,management:{},version:1,fields:{title:{type:'text',title:'名称'}}}];
    export const plugin = {id:'${id}',version:1,blocks,defines:{kind:'${id}-schema',prefix:'${id}:',build:(entity,data)=>({id:'${id}:'+entity,plugin:'${id}',template:entity,title:data.title,rebuildable:false,version:1,fields:{value:{type:'text',title:'值',search:true}}})},
    commands:{make(ctx){const entity=ctx.createEntity();ctx.put(entity,'${id}-schema',{title:'资料'});return {label:'新建定义',result:entity}}}};`
  update(root, m, encodePackage(manifest, new Map([['core.mjs', Buffer.from(code)]])))
  const h = await start(root, m)
  if (id === 'tpl') { expect(h.plan.off.get(id)).toContain('动态定义前缀不属于此插件'); return }
  expect(h.plan.enabled.has(id)).toBe(true)
  const entity = h.api.run(id, 'make', {}) as string
  expect(h.reg.kind(`${id}:${entity}`)?.title).toBe('资料')
  h.reg.setDormant([{ id: 'demo:collision', plugin: 'different', title: '旧块', rebuildable: false, version: 1, fields: {} }])
  expect(() => h.reg.setDefined([{ plugin: id, kind: { ...h.reg.kind(`${id}:${entity}`)!, id: 'demo:collision' } }], true)).toThrow('重名')
  expect(h.reg.kind('demo:collision')?.plugin).toBe('different')
  expect(h.reg.kind(`${id}:${entity}`)?.title).toBe('资料')
  const item = h.api.create({ text: { content: '正文' }, [`${id}:${entity}`]: { value: '动态内容' } }) as string
  expect((await h.api.query({ search: [{ kind: `${id}:${entity}`, field: 'value', text: '动态内容' }] })).ids).toEqual([item])
})

it.skipIf(!process.env.FIELDS_LEGACY_DIR)('准备 Electron 旧字段库与工作区', async () => {
  const dir = resolve(process.env.FIELDS_LEGACY_DIR!)
  mkdirSync(join(dir, 'user/workspaces'), { recursive: true })
  const fixture = await seedTagsTable(join(dir, 'library'), [], true)
  await seedTagsTable(join(dir, 'disabled-library'), ['fields'], true)
  writeFileSync(join(dir, 'legacy.json'), JSON.stringify(fixture))
  writeFileSync(join(dir, 'user/workspaces', `${fixture.libraryId}.json`), JSON.stringify(fixture.workspace))
})
