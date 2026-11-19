import type { ExternalBinding, PackageChanges, PackageRef, PackageRow } from '../../shared/external-plugins'
import { packageInfo } from '../../shared/package-info'
import { resolvePluginPlan, type PluginInfo } from '../../shared/plugin-plan'

export const bindingsOf = (rows: PackageRow[]): ExternalBinding[] => rows.filter(r => r.selected).map(({ manifest, hash, enabled }) => ({ manifest, hash, enabled }))

/** 选择新版即替换该 ID 的草稿；取消未应用的新选择时恢复原版本绑定。 */
export function choosePackage(draft: ExternalBinding[], saved: ExternalBinding[], ref: PackageRef, enabled: boolean): ExternalBinding[] {
  const previous = saved.find(b => b.manifest.id === ref.manifest.id)
  const binding = enabled ? { manifest: ref.manifest, hash: ref.hash, enabled } : previous ? { ...previous, enabled: false } : undefined
  return [...draft.filter(b => b.manifest.id !== ref.manifest.id), ...(binding ? [binding] : [])]
}

export function packageChanges(saved: ExternalBinding[], draft: ExternalBinding[], retries: Set<string>): PackageChanges['changes'] {
  return draft.filter(b => {
    const old = saved.find(p => p.manifest.id === b.manifest.id)
    return old?.hash !== b.hash || old.enabled !== b.enabled || (b.enabled && retries.has(b.hash))
  }).map(({ hash, enabled }) => ({ hash, enabled }))
}

export function withoutUninstalled(draft: ExternalBinding[], saved: ExternalBinding[], hash: string): ExternalBinding[] {
  return draft.flatMap(b => b.hash !== hash ? [b] : saved.filter(s => s.manifest.id === b.manifest.id))
}

/** 坏包的循环依赖也能在设置页查看并停用，不让预演阻断整个页面。 */
export function previewPluginSettings(disabled: Set<string>, plugins: PluginInfo[], draft: ExternalBinding[], rows: PackageRow[]) {
  try {
    return resolvePluginPlan([...disabled, ...draft.filter(b => !b.enabled).map(b => b.manifest.id)], [
      ...plugins, ...draft.map(b => packageInfo(b, rows.some(r => r.hash === b.hash && r.installed) ? undefined : '未安装'))
    ])
  } catch (e) {
    const plan = resolvePluginPlan(disabled, plugins)
    for (const b of draft) plan.off.set(b.manifest.id, e instanceof Error ? e.message : String(e))
    return plan
  }
}

/** 只形成草稿：沿当前版本补齐必需依赖，未选版本时必须唯一；失败不留下半批选择。 */
export function enableRequiredPlugins(id: string, disabled: Set<string>, plugins: PluginInfo[], draft: ExternalBinding[], rows: PackageRow[]) {
  const nextDisabled = new Set(disabled), nextDraft = draft.map(b => ({ ...b }))
  const visited = new Set<string>(), visiting = new Set<string>()
  const visit = (target: string) => {
    if (visiting.has(target)) throw new Error('依赖成环，请更换插件版本')
    if (visited.has(target)) return
    visiting.add(target)
    let info = plugins.find(p => p.id === target)
    if (info) {
      if (info.problem) throw new Error(`${info.title}：${info.problem}`)
      nextDisabled.delete(target)
    } else {
      let binding = nextDraft.find(b => b.manifest.id === target)
      if (!binding) {
        const candidates = rows.filter(r => r.manifest.id === target && r.installed)
        if (!candidates.length) throw new Error(`缺少依赖「${target}」，请先到应用设置安装`)
        if (candidates.length > 1) throw new Error(`「${candidates[0].manifest.title}」有多个版本，请先勾选所需版本`)
        binding = { manifest: candidates[0].manifest, hash: candidates[0].hash, enabled: true }
        nextDraft.push(binding)
      }
      if (!rows.some(r => r.hash === binding!.hash && r.installed)) throw new Error(`「${binding.manifest.title} ${binding.manifest.version}」未安装，请重新安装或选择其他版本`)
      binding.enabled = true
      info = packageInfo(binding)
    }
    for (const dependency of info.requires ?? []) visit(dependency)
    visiting.delete(target); visited.add(target)
  }
  visit(id)
  return { disabled: nextDisabled, draft: nextDraft }
}
