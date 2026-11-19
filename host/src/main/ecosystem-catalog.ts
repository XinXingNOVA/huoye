import type { EcosystemEntry } from '../shared/ecosystem-catalog'
import type { PluginInfo } from '../shared/plugin-plan'
import type { PluginPreset, PluginSelection } from '../shared/plugin-presets'
import { planPluginPreset } from '../shared/plugin-preset-plan'
import { checkToolFeatures } from '../shared/tool-placement'
import { suitePresetId, type SuiteRegistration } from '../shared/plugin-suites'
import type { PackageManager } from '../plugin-packages/manager'

/** 只读应用目录投影。只输出公开元信息，不返回目录、凭据、其他仓库绑定或完整布局。 */
export function ecosystemEntries(builtin: PluginInfo[], packages: PackageManager, presets: PluginPreset[], suites: SuiteRegistration[], root?: string): EcosystemEntry[] {
  const installed = packages.list(), bundled = packages.releasePackages()
  const all = [...installed, ...bundled.filter(p => !installed.some(i => i.hash === p.hash))]
  const env = { plugins: builtin, installed, bindings: [], development: [] }
  const base: PluginSelection = { disabled: builtin.filter(p => !p.required && p.scope !== 'application').map(p => p.id), external: [] }
  const packageIssues = new Map<string, string[]>()
  for (const ref of all) {
    const issues: string[] = []
    try { checkToolFeatures([], ref.manifest.uiFeatures) }
    catch { issues.push('界面契约已退役，请升级插件') }
    if (installed.some(p => p.hash === ref.hash)) {
      try { packages.verify(ref.hash) } catch { issues.push('安装内容校验失败，请在应用设置修复插件包') }
    } else issues.push('插件包未安装')
    packageIssues.set(ref.hash, issues)
  }
  const preview = (preset: PluginPreset) => {
    const plan = planPluginPreset(preset, 'replace', base, env, 'catalog')
    return [...new Set([...plan.issues, ...plan.selection.external.filter(p => p.enabled).flatMap(p => packageIssues.get(p.hash) ?? [])])]
  }
  const entries: EcosystemEntry[] = builtin.map(p => ({
    kind: 'plugin', id: p.id, title: p.title, description: p.description, source: 'builtin',
    scope: p.scope ?? 'library', required: !!p.required, catalog: p.catalog, installed: true,
    requires: p.requires ?? [], authorization: 'builtin', runtime: 'not-checked',
    issues: p.scope === 'application' ? [] : preview({ id: 'catalog', revision: 'catalog', title: p.title, plugins: [{ id: p.id, title: p.title }] })
  }))
  for (const p of all) {
    const isInstalled = installed.some(i => i.hash === p.hash), isBundled = bundled.some(i => i.hash === p.hash)
    const granted = root ? packages.authorization(root, p.hash) : undefined
    entries.push({
      kind: 'plugin', id: p.manifest.id, title: p.manifest.title, description: p.manifest.description,
      source: isBundled ? 'bundled' : 'installed', scope: 'library', version: p.manifest.version, hash: p.hash,
      catalog: p.manifest.catalog, installed: isInstalled, requires: p.manifest.requires,
      authorization: !isInstalled ? 'not-installed' : granted && granted !== 'approval-required' ? granted : packages.automationAllowed(p.hash) ? (isBundled ? 'bundled-on-first-open' : 'granted') : root ? packages.authorization(root, p.hash) : 'approval-required',
      runtime: 'not-checked', issues: [...new Set([...(packageIssues.get(p.hash) ?? []), ...preview({ id: 'catalog', revision: 'catalog', title: p.manifest.title, plugins: [{ id: p.manifest.id, title: p.manifest.title, hash: p.hash }] })])]
    })
  }
  for (const p of presets) entries.push({
    kind: 'preset', id: p.id, title: p.title, description: p.description ?? '', source: p.source?.kind === 'suite' ? 'suite' : 'user', revision: p.revision,
    requires: p.plugins.map(p => p.id), plugins: p.plugins.map(p => ({ id: p.id, version: p.version, hash: p.hash })), hasLayout: !!p.layout,
    runtime: 'not-checked', issues: preview(p)
  })
  for (const s of suites) entries.push({
    kind: 'suite', id: s.manifest.id, title: s.manifest.title, description: s.manifest.description,
    source: s.bundled ? 'bundled' : 'installed', version: s.manifest.version, hash: s.hash,
    requires: [...new Set(s.manifest.presets.flatMap(p => p.plugins.map(p => p.id)))],
    presets: s.manifest.presets.map(p => suitePresetId(s.manifest.id, p.id)), runtime: 'not-checked',
    issues: [...new Set(entries.filter(e => e.kind === 'preset' && s.manifest.presets.some(p => suitePresetId(s.manifest.id, p.id) === e.id)).flatMap(e => e.issues))]
  })
  return entries.sort((a, b) => `${a.kind}:${a.id}:${a.hash ?? ''}`.localeCompare(`${b.kind}:${b.id}:${b.hash ?? ''}`))
}
