import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PluginPresetCatalog } from './presets'
import { SuiteCatalog } from './suites'
import { canonical, type PackageRef } from '../shared/external-plugins'
import { planPluginPreset, type PresetEnvironment } from '../shared/plugin-preset-plan'
import { presetReferenceSchema, type PluginPreset, type PluginSelection } from '../shared/plugin-presets'
import { startingPresetSchema, type CreationPreview, creationPluginsSchema } from '../shared/library-creation'
import type { PluginDistribution } from '../shared/plugin-distribution'
import type { PluginInfo } from '../shared/plugin-plan'

/** 开始页和仓库设置共用同一方案目录、修订与预演规则。 */
export class PresetCatalog {
  readonly users: PluginPresetCatalog
  constructor(directory: string, private suites = new SuiteCatalog(join(directory, 'plugin-suites.json'))) {
    this.users = new PluginPresetCatalog(join(directory, 'plugin-presets.json'))
  }
  list(): PluginPreset[] {
    return [...this.users.list().map(p => ({ ...p, editable: true, source: { kind: 'user' as const } })), ...this.suites.presets()]
  }
  get(id: string) {
    presetReferenceSchema.parse(id)
    const p = this.list().find(p => p.id === id)
    if (!p) throw new Error('方案已不存在，请刷新')
    return p
  }
  previewNew(raw: unknown, builtin: PluginInfo[], distribution: PluginDistribution[], installed: PackageRef[], bundled: PackageRef[], explicit?: import('zod').z.input<typeof creationPluginsSchema>): CreationPreview {
    const input = raw === undefined ? undefined : startingPresetSchema.parse(raw)
    const chosenPlugins = explicit === undefined ? undefined : creationPluginsSchema.parse(explicit)
    for (const p of chosenPlugins ?? []) if (p.hash && !installed.some(i => i.manifest.id === p.id && i.hash === p.hash)) throw new Error(`所选插件摘要未安装：${p.id}`)
    if (input && chosenPlugins) throw new Error('起始方案与明确插件组合只能选择一种')
    const preset = input ? this.get(input.id) : undefined
    if (preset && preset.revision !== input!.revision) throw new Error('方案已变化，请重新选择并预览')
    const env: PresetEnvironment = { plugins: builtin, installed, development: [], bindings: [] }
    // 方案从核心能力起步；默认创建沿用发行策略，不将本机所有安装包自动启用。
    const base: PluginSelection = {
      disabled: builtin.filter(p => !p.required && p.scope !== 'application' && (preset || chosenPlugins || !distribution.find(d => d.id === p.id)?.defaultEnabled)).map(p => p.id),
      external: []
    }
    if (input) {
      for (const v of input.versions) {
        if (!v.enabled || !installed.some(p => p.manifest.id === v.id && p.hash === v.hash)) throw new Error('所选插件版本未安装')
      }
      base.external = input.versions
    }
    const chosen = preset ?? (chosenPlugins ? { id: 'explicit', revision: 'explicit', title: '指定插件组合', plugins: chosenPlugins.map(p => ({ ...p, title: p.id })) } : {
      id: 'default', revision: 'default', title: '默认创建',
      plugins: [
        ...builtin.filter(p => !p.required && p.scope !== 'application' && !base.disabled.includes(p.id)).map(p => ({ id: p.id, title: p.title })),
        ...bundled.filter(p => installed.some(i => i.hash === p.hash) && distribution.find(d => d.id === p.manifest.id)?.defaultEnabled).map(p => ({ id: p.manifest.id, title: p.manifest.title, hash: p.hash }))
      ]
    })
    const revision = createHash('sha256').update(canonical({ input, chosen, installed: installed.map(p => p.hash).sort(), builtin, distribution })).digest('hex')
    const result = planPluginPreset(chosen, 'replace', base, env, revision)
    const relevant = new Set(chosen.plugins.map(p => p.id))
    for (const id of relevant) {
      for (const dep of builtin.find(p => p.id === id)?.requires ?? []) relevant.add(dep)
      for (const p of installed.filter(p => p.manifest.id === id)) for (const dep of p.manifest.requires) relevant.add(dep)
    }
    if (input?.versions.some(v => !relevant.has(v.id))) throw new Error('版本选择包含方案之外的插件')
    const versions = [...relevant].flatMap(id => {
      const packs = installed.filter(p => p.manifest.id === id)
      return packs.length ? [{ id, title: packs[0].manifest.title, choices: packs.map(p => ({ hash: p.hash, version: p.manifest.version })) }] : []
    })
    return { ...result, preset, versions }
  }
}
