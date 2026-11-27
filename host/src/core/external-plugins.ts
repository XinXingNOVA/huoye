import { consumedCapabilities } from '../shared/capability-declarations'
import { validateDataLifecycle } from './plugin-data-registration'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { Library } from './library'
import type { CorePlugin } from '../plugin-api/core/contracts'
import { Registry } from './registry'
import { bindingSchema, canonical, kindSnapshot, packageInfo, pluginSettingsSchema, type ExternalBinding, type InstalledPackage, type PackageRef } from '../shared/external-plugins'
import { resolvePluginPlan, validateContributions, validatePlugins, type PluginInfo } from '../shared/plugin-plan'
import type { BlockKind } from '../shared/blocks'
import type { PluginDistribution } from '../shared/plugin-distribution'
import { initializePluginDefaults } from './plugin-defaults'
import { buildDefinedKind } from './defined-kinds'
import { acceptsSchema, preflightCompatibleData, validateCompatibleSchemas } from './schema-compatibility'

export function readBindings(lib: Library): ExternalBinding[] {
  const raw = lib.db.prepare("SELECT value FROM main.config WHERE key = 'externalPlugins'").pluck().get() as string | undefined
  if (!raw) return []
  return bindingSchema.array().max(100).parse(JSON.parse(raw))
}
export function setBinding(lib: Library, value: ExternalBinding, builtin: PluginInfo[]): void {
  const binding = bindingSchema.parse(value)
  if (builtin.some(p => p.id === binding.manifest.id && !p.external)) throw new Error('不能替换内置插件')
  const bindings = readBindings(lib).filter(b => b.manifest.id !== binding.manifest.id)
  bindings.push(binding)
  lib.db.transaction(() => {
    lib.db.prepare("INSERT INTO main.config (key, value) VALUES ('externalPlugins', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(bindings))
    clearLegacyDisabled(lib, binding.manifest.id)
  })()
}

function clearLegacyDisabled(lib: Library, id: string): void {
  const raw = lib.db.prepare("SELECT value FROM main.config WHERE key = 'plugins'").pluck().get() as string | undefined
  if (!raw) return
  let config: { disabled?: unknown }
  try { config = JSON.parse(raw) } catch { return }
  if (!config || !Array.isArray(config.disabled) || !config.disabled.includes(id)) return
  config.disabled = config.disabled.filter(x => x !== id)
  lib.db.prepare("UPDATE main.config SET value = ? WHERE key = 'plugins'").run(JSON.stringify(config))
}

/** 主进程仅传入应用交付的包。每个仓库交接一次，之后尊重外部绑定和卸载选择。 */
export function adoptBundledPlugins(lib: Library, packages: PackageRef[], builtin: PluginInfo[], catalog?: PluginDistribution[], selection?: { disabled: string[]; external: ExternalBinding[] }): void {
  lib.db.transaction(() => {
    const initial = catalog ? initializePluginDefaults(lib, builtin, catalog) : undefined
    if (selection) setPluginSettings(lib, selection.disabled, selection.external, builtin)
    const disabled = readDisabled(lib)
    for (const ref of packages) {
      const key = `packagedBuiltin:${ref.manifest.id}`
      if (lib.db.prepare('SELECT 1 FROM main.config WHERE key = ?').get(key)) continue
      const existing = readBindings(lib).find(b => b.manifest.id === ref.manifest.id)
      const policy = catalog?.find(p => p.id === ref.manifest.id && p.origin === 'bundled')
      const preserve = !initial || (policy?.legacyBuiltin && (initial.legacy || initial.known.has(ref.manifest.id)))
      const enabled = preserve ? !disabled.includes(ref.manifest.id) : !!(initial?.fresh && policy?.defaultEnabled)
      if (!selection || existing) setBinding(lib, existing ?? { ...ref, enabled }, builtin)
      lib.db.prepare('INSERT INTO main.config (key, value) VALUES (?, ?)').run(key, JSON.stringify({ hash: ref.hash }))
    }
  })()
}
export function readDisabled(lib: Library): string[] {
  const raw = lib.db.prepare("SELECT value FROM main.config WHERE key = 'plugins'").pluck().get() as string | undefined
  try { const d = raw ? JSON.parse(raw).disabled : []; return Array.isArray(d) ? d.filter(x => typeof x === 'string') : [] } catch { return [] }
}

/** 内置选择与外部版本绑定在同一配置事务提交；不改变本次运行的装配。 */
export function setPluginSettings(lib: Library, disabled: string[], external: ExternalBinding[], manifest: PluginInfo[]): void {
  const settings = pluginSettingsSchema.parse({ disabled, external })
  if (new Set(settings.external.map(b => b.manifest.id)).size !== settings.external.length) throw new Error('同一插件只能选择一个版本')
  const known = new Set(manifest.filter(p => !p.required && !p.external).map(p => p.id))
  const clean = [...new Set(settings.disabled)].filter(id => known.has(id))
  lib.db.transaction(() => {
    lib.db.prepare("INSERT INTO main.config (key, value) VALUES ('plugins', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ disabled: clean }))
    for (const binding of settings.external) setBinding(lib, binding, manifest)
    readBindings(lib) // 总绑定数量也必须有效，失败时整体回滚。
  })()
}

/** 在保存定义、迁移或启动加工之前拒绝结构变化；首次启用后保存完整契约，连暂未使用的块也参与比较。 */
export function checkPackageKinds(lib: Library, id: string, kinds: BlockKind[], defines?: CorePlugin['defines'], history: BlockKind[] = []): void {
  validateCompatibleSchemas({ id, version: 1, blocks: kinds, defines, compatibleSchemas: history })
  const snapshots = kinds.filter(k => !k.rebuildable).map(kindSnapshot).sort((a, b) => a.id.localeCompare(b.id))
  const saved = lib.db.prepare('SELECT value FROM main.config WHERE key = ?').pluck().get(`externalSchema:${id}`) as string | undefined
  if (saved) {
    const old = JSON.parse(saved) as BlockKind[]
    if (old.length !== snapshots.length || old.some(k => !acceptsSchema(k, snapshots.find(n => n.id === k.id), history))) throw new Error('此版本改变了持久数据结构，缺少可兼容的旧定义或正在降级')
  }
  const descriptor = defines ? { kind: defines.kind, prefix: defines.prefix } : null
  const savedDefiner = lib.db.prepare('SELECT value FROM main.config WHERE key = ?').pluck().get(`externalDefinitions:${id}`) as string | undefined
  if (savedDefiner && canonical(JSON.parse(savedDefiner)) !== canonical(descriptor)) throw new Error('此版本改变了动态定义契约')
  const previous = (lib.db.prepare('SELECT def FROM main.kind_def').pluck().all() as string[]).map(s => JSON.parse(s) as BlockKind)
  const generated = new Map<string, BlockKind>()
  if (defines) {
    const rows = lib.db.prepare('SELECT entity_id, data FROM main.block WHERE kind = ?').all(defines.kind) as { entity_id: string; data: string }[]
    for (const row of rows) {
      const kind = defines.build(row.entity_id, JSON.parse(row.data))
      if (kinds.some(k => k.id === kind.id) || previous.some(k => k.id === kind.id && k.plugin !== id)) throw new Error(`动态数据块 ${kind.id} 与已有归属冲突`)
      generated.set(kind.id, kind)
    }
  }
  for (const old of previous.filter(k => k.plugin === id && !k.rebuildable)) {
    if (defines?.prefix && old.template && old.id === defines.prefix + old.template) {
      const current = generated.get(old.id)
      // 已删除模板留下的历史快照不重新解释；撤销时由原记录重新构造。
      if (!current && !lib.db.prepare('SELECT 1 FROM main.block WHERE kind = ? LIMIT 1').get(old.id)) continue
      if (canonical(kindSnapshot(old)) !== canonical(current && kindSnapshot(current))) throw new Error('仓库中的动态数据定义与插件包不兼容')
      continue
    }
    if (!acceptsSchema(old, snapshots.find(k => k.id === old.id), history)) throw new Error('仓库中的数据定义与插件包不兼容')
  }
  for (const kind of kinds) if (previous.some(k => k.id === kind.id && k.plugin !== id)) throw new Error(`数据块 ${kind.id} 已归属其他插件`)
}

/** 只有应用发行策略可登记前缀例外，且旧 ID 不能被其他包的前缀抢占。 */
export function checkPackageOwnership(id: string, kinds: BlockKind[], catalog: PluginDistribution[]): void {
  const owners = new Map(catalog.filter(p => p.origin === 'bundled' && p.legacyBuiltin).flatMap(p => (p.legacyKinds ?? []).map(kind => [kind, p.id] as const)))
  for (const k of kinds) {
    const owner = owners.get(k.id)
    if (k.plugin !== id || catalog.some(p => p.legacyDefinitionPrefixes?.some(prefix => k.id.startsWith(prefix))) || (owner ? owner !== id : !k.id.startsWith(id))) throw new Error(`数据块 ${k.id} 不在插件 ${id} 的命名范围或旧 ID 归属内`)
  }
}

function withDefinitions(plugin: CorePlugin, declaration: PackageRef['manifest']['definitions'], catalog: PluginDistribution[]): CorePlugin {
  if (!declaration && !plugin.defines) return plugin
  const definer = plugin.defines
  if (!declaration || !definer || declaration.kind !== definer.kind || declaration.prefix !== definer.prefix || typeof definer.build !== 'function') throw new Error('动态定义必须与插件包声明一致')
  const owner = catalog.find(p => p.origin === 'bundled' && p.legacyBuiltin && p.legacyDefinitionPrefixes?.includes(declaration.prefix))
  if (owner ? owner.id !== plugin.id : declaration.prefix !== `${plugin.id}:`) throw new Error('动态定义前缀不属于此插件')
  const source = plugin.blocks?.find(k => k.id === declaration.kind)
  if (!source || source.plugin !== plugin.id || !source.management || !source.standalone || source.rebuildable || source.content || source.history === false) throw new Error('动态定义的来源必须为本插件的持久管理记录')
  return { ...plugin, defines: { ...definer, build: (entity, data) => buildDefinedKind(plugin, source, entity, data) } }
}

export async function loadExternalCore(lib: Library, builtins: PluginInfo[], cores: CorePlugin[], installed: InstalledPackage[], catalog: PluginDistribution[] = [], override?: ExternalBinding[]) {
  const development = installed.filter(p => p.development)
  const ids = new Set(development.map(p => p.manifest.id))
  if (ids.size !== development.length) throw new Error('开发插件 ID 重复')
  const bindings = [...(override ?? readBindings(lib)).filter(b => !ids.has(b.manifest.id)), ...development.map(p => ({ ...p, enabled: true }))]
  const disabled = readDisabled(lib).filter(id => !ids.has(id))
  const manifest: PluginInfo[] = [...builtins]
  const packages = new Map<string, InstalledPackage>()
  for (const b of bindings) {
    if (builtins.some(p => p.id === b.manifest.id)) throw new Error('外部插件配置占用内置 ID')
    const pack = installed.find(p => !!p.development === ids.has(b.manifest.id) && p.hash === b.hash && canonical(p.manifest) === canonical(b.manifest))
    const info = packageInfo(b, pack ? pack.problem : '所需插件包未安装')
    if (pack?.development) info.external!.development = true
    manifest.push(info)
    if (!b.enabled) disabled.push(b.manifest.id)
    if (pack) packages.set(b.manifest.id, pack)
  }
  // 候选依赖环只停用外部组合，不阻止仓库基本访问。
  try { validatePlugins(manifest, true) } catch (e) {
    for (const p of manifest.filter(p => p.external)) { p.problem = String(e); p.requires = []; p.optional = [] }
  }
  const active: CorePlugin[] = []
  const visited = new Set<string>()
  const ordered: PluginInfo[] = []
  const visit = (p: PluginInfo) => {
    if (visited.has(p.id)) return
    visited.add(p.id)
    for (const id of p.requires ?? []) { const dep = manifest.find(p => p.id === id); if (dep) visit(dep) }
    if (p.external) ordered.push(p)
  }
  manifest.forEach(visit)
  for (const info of ordered) {
    if (!resolvePluginPlan(disabled, manifest).enabled.has(info.id)) continue
    const pack = packages.get(info.id)!
    try {
      const p = await checkExternalPackage(lib, pack, catalog)
      if (!p) continue
      validateContributions([p], ['recognizers', 'systems', 'exportSections'], manifest)
      new Registry([...cores, ...active, p])
      active.push(p)
    } catch (e) { info.problem = `加载失败：${e instanceof Error ? e.message : e}` }
  }
  const enabled = resolvePluginPlan(disabled, manifest).enabled
  return { manifest, plugins: [...cores, ...active.filter(p => enabled.has(p.id))] }
}

/** 更新预检复用正式加载的结构检查；停用插件也必须检查持久契约。 */
export async function checkExternalPackage(lib: Library, pack: InstalledPackage, catalog: PluginDistribution[]) {
  if (!pack.manifest.entries.core) { checkPackageKinds(lib, pack.manifest.id, []); return undefined }
  const url = pathToFileURL(join(pack.directory, pack.manifest.entries.core)).href
  const module = await import(/* @vite-ignore */ url) as { plugin: CorePlugin; blocks: BlockKind[] }
  let p = module.plugin
  if (!p || p.id !== pack.manifest.id || !Array.isArray(module.blocks) || (p.blocks ? p.blocks !== module.blocks : module.blocks.length > 0)) throw new Error('核心 ID 或共用 blocks 导出与声明不符')
  for (const system of p.systems ?? []) {
    if (system.requires?.programs?.length) throw new Error('外部加工应声明所消费的能力')
    if ((system.requires?.capabilities ?? []).some(id => !pack.manifest.capabilities?.consumes?.includes(id)) || (system.optionalCapabilities ?? []).some(id => !consumedCapabilities(pack.manifest.capabilities).includes(id))) throw new Error('加工依赖必须列入能力消费清单')
  }
  if (p.migrations) throw new Error('首版外部插件不支持结构迁移')
  if (p.systems?.some(s => s.relatedInputs) && !pack.manifest.coreFeatures?.includes('related-inputs-v1')) throw new Error('关联加工必须声明 related-inputs-v1')
  if (p.ingestMetadata?.length && !pack.manifest.coreFeatures?.includes('ingest-metadata-v1')) throw new Error('导入附加能力必须声明 ingest-metadata-v1')
  if (p.queries?.length && !pack.manifest.coreFeatures?.includes('business-queries-v1')) throw new Error('业务只读查询必须显式声明 business-queries-v1 核心能力')
  if (p.operations?.some(op => op.reviewable !== undefined) && !pack.manifest.coreFeatures?.includes('operation-review-v1')) throw new Error('排除通用验收必须声明 operation-review-v1 核心能力')
  if (p.operations?.some(op => op.effect !== undefined) && !pack.manifest.coreFeatures?.includes('operation-effects-v1')) throw new Error('操作影响类别必须显式声明 operation-effects-v1 核心能力')
  if (module.blocks?.some(k => k.container || k.allowOnContainer) && !pack.manifest.coreFeatures?.includes('entity-roles-v1')) throw new Error('容器角色必须声明 entity-roles-v1 核心能力')
  if (module.blocks?.some(k => k.ownedBy !== undefined) && !pack.manifest.coreFeatures?.includes('owned-records-v1')) throw new Error('从属记录必须声明 owned-records-v1')
  if (p.compatibleSchemas && !pack.manifest.coreFeatures?.includes('compatible-schemas-v1')) throw new Error('兼容旧定义必须显式声明核心能力')
  if (p.dataLifecycle && !pack.manifest.coreFeatures?.includes('data-lifecycle-v1')) throw new Error('生命周期声明必须显式声明 data-lifecycle-v1')
  validateDataLifecycle(p)
  validateCompatibleSchemas(p)
  p = withDefinitions(p, pack.manifest.definitions, catalog)
  checkPackageOwnership(pack.manifest.id, module.blocks, catalog)
  checkPackageKinds(lib, pack.manifest.id, module.blocks, p.defines, p.compatibleSchemas)
  preflightCompatibleData(lib, p)
  return p
}
