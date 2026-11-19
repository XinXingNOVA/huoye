import { canonical, type InstalledPackage } from '../shared/external-plugins'
import type { PackageUpdateRequest } from '../shared/plugin-updates'
import type { Library } from './library'
import { checkExternalPackage, loadExternalCore, readBindings, readDisabled, setBinding } from './external-plugins'
import { PLUGINS } from '../plugins/manifest'
import { corePlugins } from '../plugins/core'
import { DISTRIBUTION } from '../plugins/generated/distribution'
import { resolvePluginPlan } from '../shared/plugin-plan'

/** 唯一写入核心里按原选择比较后替换；重试已切换的同一记录是幂等的。 */
export async function updateLibraryPackage(lib: Library, input: PackageUpdateRequest) {
  if (lib.id !== input.libraryId) throw new Error('仓库身份已变化，未更新')
  const bindings = readBindings(lib), current = bindings.find(b => b.manifest.id === input.previous.manifest.id)
  const next = { ...input.next, enabled: input.binding.enabled }
  if (!current || (canonical(current) !== canonical(input.binding) && canonical(current) !== canonical(next))) throw new Error('插件选择已变化，请重新预览；未覆盖当前选择')
  const candidate = input.packages.find(p => p.hash === next.hash)
  if (!candidate || candidate.development) throw new Error('新包缺失或仍在开发模式')
  await checkExternalPackage(lib, candidate, DISTRIBUTION)
  const proposed = bindings.map(b => b.manifest.id === next.manifest.id ? next : b)
  const packs: InstalledPackage[] = input.packages.map(p => p.hash === next.hash ? { ...p, problem: undefined } : p)
  const loaded = await loadExternalCore(lib, PLUGINS, corePlugins, packs, DISTRIBUTION, proposed)
  const plan = resolvePluginPlan([...readDisabled(lib), ...proposed.filter(b => !b.enabled).map(b => b.manifest.id)], loaded.manifest)
  if (next.enabled && !plan.enabled.has(next.manifest.id)) throw new Error(plan.off.get(next.manifest.id) ?? '新版本不能启用')
  // 不能因更新破坏其他已选插件。旧有无关的失效状态允许保持。
  const before = await loadExternalCore(lib, PLUGINS, corePlugins, input.packages, DISTRIBUTION, bindings)
  const prior = resolvePluginPlan([...readDisabled(lib), ...bindings.filter(b => !b.enabled).map(b => b.manifest.id)], before.manifest)
  for (const id of prior.enabled) if (!plan.enabled.has(id)) throw new Error(`更新将使 ${id} 不可用：${plan.off.get(id)}`)
  if (input.action === 'replace') lib.db.transaction(() => {
    const now = readBindings(lib).find(b => b.manifest.id === next.manifest.id)
    if (canonical(now) !== canonical(current)) throw new Error('预检期间插件选择已改变，未覆盖')
    setBinding(lib, next, PLUGINS)
  })()
}
