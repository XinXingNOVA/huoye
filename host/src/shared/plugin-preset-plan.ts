import { canonical, type ExternalBinding, type PackageRef } from './external-plugins'
import { packageInfo } from './package-info'
import { resolvePluginPlan, type PluginInfo } from './plugin-plan'
import { pluginSelectionSchema, type PluginPreset, type PluginPresetMode, type PluginPresetPreview, type PluginSelection } from './plugin-presets'

export interface PresetEnvironment {
  plugins: PluginInfo[]
  bindings: ExternalBinding[]
  installed: PackageRef[]
  development: PluginInfo[]
}
const editable = (p: PluginInfo) => !p.required && p.scope !== 'application'
/** 只认可宿主清单／安装登记；客户端不提供 manifest，也不能借预设更换开发来源。 */
export function validateSelection(raw: PluginSelection, env: PresetEnvironment): PluginSelection {
  const selection = pluginSelectionSchema.parse(raw)
  for (const id of selection.disabled) if (!env.plugins.some(p => p.id === id && editable(p))) throw new Error(`不能停用未知、核心或应用级功能：${id}`)
  for (const old of env.bindings) if (!selection.external.some(p => p.id === old.manifest.id)) throw new Error('选择缺少已有插件登记，请重新读取仓库选择')
  for (const selected of selection.external) {
    if (env.plugins.some(p => p.id === selected.id)) throw new Error('外部选择不能替换内部功能')
    const old = env.bindings.find(p => p.manifest.id === selected.id)
    if (env.development.some(p => p.id === selected.id) && canonical(selected) !== canonical(old && { id: old.manifest.id, hash: old.hash, enabled: old.enabled }))
      throw new Error(`「${selected.id}」处于开发模式，请先在开发区域处理`)
    if (!env.installed.some(p => p.manifest.id === selected.id && p.hash === selected.hash) && !(old?.hash === selected.hash))
      throw new Error(`插件版本未安装：${selected.id}`)
  }
  return selection
}
const reference = (env: PresetEnvironment, id: string, hash: string) =>
  env.installed.find(p => p.manifest.id === id && p.hash === hash) ?? env.bindings.find(p => p.manifest.id === id && p.hash === hash)

export function capturePluginSelection(raw: PluginSelection, env: PresetEnvironment): PluginPreset['plugins'] {
  const selection = validateSelection(raw, env), dev = new Set(env.development.map(p => p.id))
  return [
    ...env.plugins.filter(p => editable(p) && !selection.disabled.includes(p.id)).map(p => ({ id: p.id, title: p.title })),
    ...selection.external.filter(p => p.enabled && !dev.has(p.id)).map(p => {
      const ref = reference(env, p.id, p.hash)!
      return { id: p.id, title: ref.manifest.title, version: ref.manifest.version }
    })
  ].sort((a, b) => a.id.localeCompare(b.id))
}

/** 不执行插件代码；只校验公开声明的依赖。加载时的数据契约检查仍归原装配器。 */
export function selectionIssues(raw: PluginSelection, env: PresetEnvironment): string[] {
  const s = validateSelection(raw, env), dev = new Set(env.development.map(p => p.id))
  const selected = s.external.filter(p => p.enabled && !dev.has(p.id))
  const infos = selected.map(p => packageInfo(reference(env, p.id, p.hash)!, env.installed.some(r => r.hash === p.hash) ? undefined : '所选构建未安装'))
  try {
    const plan = resolvePluginPlan(s.disabled, [...env.plugins, ...infos, ...env.development])
    return [...env.plugins.filter(p => !s.disabled.includes(p.id)), ...infos, ...env.development]
      .filter(p => plan.off.has(p.id)).map(p => `${p.title}：${plan.off.get(p.id)}`)
  } catch (e) { return [e instanceof Error ? e.message : String(e)] }
}

export function planPluginPreset(preset: PluginPreset, mode: PluginPresetMode, raw: PluginSelection, env: PresetEnvironment, revision: string, versions: PluginSelection['external'] = []): PluginPresetPreview {
  if (mode !== 'add' && mode !== 'replace') throw new Error('无效组合应用方式')
  const base = validateSelection(raw, env), dev = new Set(env.development.map(p => p.id))
  const disabled = new Set(mode === 'add' ? base.disabled : env.plugins.filter(editable).map(p => p.id))
  const external = base.external.map(p => ({ ...p, enabled: mode === 'replace' && !dev.has(p.id) ? false : p.enabled }))
  const overrides = pluginSelectionSchema.shape.external.parse(versions)
  if (new Set(overrides.map(v => v.id)).size !== overrides.length) throw new Error('版本选择不能重复')
  for (const v of overrides) {
    if (!v.enabled || !env.installed.some(p => p.manifest.id === v.id && p.hash === v.hash) || dev.has(v.id)) throw new Error('所选版本不可用')
    const at = external.findIndex(p => p.id === v.id)
    if (at < 0) external.push(v); else external[at] = v
  }
  const issues: string[] = [], warnings: string[] = [], visited = new Set<string>(), visiting = new Set<string>()
  const requested = new Set(preset.plugins.map(p => p.id))
  const visit = (id: string, fromDevelopment = false) => {
    if (visiting.has(id)) { issues.push(`插件依赖成环：${id}`); return }
    if (visited.has(id)) return
    if (dev.has(id)) {
      if (!fromDevelopment) issues.push(`「${id}」处于开发模式，请先退出开发模式再应用包含它的组合`)
      return
    }
    visiting.add(id)
    let info = env.plugins.find(p => p.id === id)
    if (info?.scope === 'application') { issues.push(`应用级功能不参与仓库组合：${info.title}`) }
    else if (info) disabled.delete(id)
    else {
      let selected = external.find(p => p.id === id)
      if (!selected) {
        const recommended = preset.plugins.find(p => p.id === id)?.hash
        const matching = env.installed.filter(p => p.manifest.id === id)
        const preferred = matching.filter(p => p.hash === recommended)
        const available = preferred.length ? preferred : matching
        if (available.length === 1) { selected = { id, hash: available[0].hash, enabled: true }; external.push(selected) }
        else issues.push(available.length ? `「${id}」有多个已安装版本，请选择使用版本` : `缺少插件「${id}」，请先到应用设置安装`)
      }
      if (selected) {
        selected.enabled = true
        const ref = reference(env, id, selected.hash)!
        info = packageInfo(ref)
        const member = preset.plugins.find(p => p.id === id)
        if (member?.version && member.version !== ref.manifest.version) {
          warnings.push(`${ref.manifest.title}：预选 ${ref.manifest.version}，${member.hash ? '套件推荐' : '组合保存时为'} ${member.version}`)
        } else if (member?.hash && member.hash !== ref.hash) {
          warnings.push(`${ref.manifest.title}：预选 ${ref.manifest.version}，与套件推荐的安装包构建不同`)
        }
      }
    }
    for (const dep of info?.requires ?? []) visit(dep, fromDevelopment)
    visiting.delete(id); visited.add(id)
  }
  preset.plugins.forEach(p => visit(p.id))
  // 开发来源本身不切换；按组合替换也不能无意停掉它已经依赖的内部／正式能力。
  if (mode === 'replace') for (const p of env.development) for (const dep of p.requires ?? []) visit(dep, true)
  if (dev.size) warnings.push(`开发插件保持原样，不写入组合：${[...dev].join('、')}`)
  if (overrides.some(v => !visited.has(v.id))) throw new Error('版本选择包含方案之外的插件')
  const candidates = [...visited].flatMap(id => {
    const packs = env.installed.filter(p => p.manifest.id === id)
    return packs.length ? [{ id, title: packs[0].manifest.title, selected: external.find(p => p.id === id)?.hash, recommended: preset.plugins.find(p => p.id === id)?.hash, choices: packs.map(p => ({ hash: p.hash, version: p.manifest.version })) }] : []
  })
  const selection = { disabled: [...disabled].sort(), external }
  issues.push(...selectionIssues(selection, env))
  const changes: PluginPresetPreview['changes'] = []
  for (const p of env.plugins.filter(editable)) {
    const enabled = !disabled.has(p.id)
    if (enabled !== !base.disabled.includes(p.id)) changes.push({ id: p.id, title: p.title, enabled, dependency: enabled && !requested.has(p.id) })
  }
  for (const p of external.filter(p => !dev.has(p.id))) {
    const before = base.external.find(b => b.id === p.id), ref = reference(env, p.id, p.hash)!
    if (p.enabled !== !!before?.enabled || (p.enabled && before?.hash !== p.hash)) changes.push({
      id: p.id, title: ref.manifest.title, enabled: p.enabled, version: ref.manifest.version,
      previousVersion: before ? reference(env, before.id, before.hash)?.manifest.version : undefined,
      dependency: p.enabled && !requested.has(p.id)
    })
  }
  return { selection, revision, versions: candidates, development: [...dev], changes, issues: [...new Set(issues)], warnings }
}
