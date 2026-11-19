// 纯数据的插件声明与启停规则；核心、设置预演、生成器共用。
export interface PluginInfo {
  catalog?: import('./plugin-presentation').PluginCatalog
  id: string
  scope?: 'application' | 'library'
  title: string
  description: string
  /** 装配顺序；同值按 ID 排序，不改变扩展点自身的 priority / order。 */
  order?: number
  requires?: string[]
  optional?: string[]
  required?: boolean
  entries?: { blocks?: string; core?: string; ui?: string; service?: string }
  /** 独立进程入口，键是稳定的输出文件名。 */
  executables?: Record<string, string>
  /** 外部包的不可变发布物；problem 只描述本次装配，不覆盖用户选择。 */
  external?: { hash: string; version: string; development?: boolean }
  problem?: string
}

export interface PluginPlan {
  enabled: Set<string>
  off: Map<string, string>
}

/** RPC 中的实际装配状态。配置改动要重载后才反映在这里。 */
export interface PluginAssembly {
  plugins: { id: string; enabled: boolean; chosen: boolean; reason?: string; unavailable?: string }[]
}

export function enabledPlugins(assembly: PluginAssembly, manifest: PluginInfo[]): Set<string> {
  const ids = assembly.plugins.map((p) => p.id)
  if (new Set(ids).size !== ids.length || ids.length !== manifest.length || manifest.some((p) => !ids.includes(p.id))) {
    throw new Error('核心与界面的插件清单不一致，请重新构建并重载仓库')
  }
  return new Set(assembly.plugins.filter((p) => p.enabled).map((p) => p.id))
}

export function validatePlugins(list: PluginInfo[], allowMissing = false): void {
  const byId = new Map<string, PluginInfo>()
  for (const p of list) {
    if (!/^[a-z][a-z0-9-]*$/.test(p.id) || p.id === 'host') throw new Error(`插件 ID 无效或保留：${p.id}`)
    if (byId.has(p.id)) throw new Error(`插件 ID 重复：${p.id}`)
    byId.set(p.id, p)
  }
  for (const p of list) {
    const deps = [...(p.requires ?? []), ...(p.optional ?? [])]
    if (new Set(deps).size !== deps.length) throw new Error(`插件 ${p.id} 的依赖重复`)
    for (const id of deps) {
      if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'host' || id === p.id || (!byId.has(id) && !p.external && !allowMissing)) throw new Error(`插件 ${p.id} 的依赖 ${id} 不存在或指向自身`)
    }
    for (const id of deps) {
      if (byId.has(id) && (p.scope ?? 'library') !== (byId.get(id)!.scope ?? 'library')) throw new Error(`插件 ${p.id} 不能跨作用域依赖 ${id}`)
    }
    for (const id of p.requires ?? []) {
      if (p.required && !byId.get(id)?.required) throw new Error(`必需插件 ${p.id} 不能依赖缺失或可停用插件 ${id}`)
    }
  }
  const done = new Set<string>()
  const visit = (id: string, path: string[]) => {
    if (!byId.has(id)) return
    if (path.includes(id)) throw new Error(`插件依赖成环：${[...path, id].join(' → ')}`)
    if (done.has(id)) return
    for (const dep of byId.get(id)!.requires ?? []) visit(dep, [...path, id])
    done.add(id)
  }
  for (const p of list) visit(p.id, [])
}

export function resolvePluginPlan(disabled: Iterable<string>, list: PluginInfo[]): PluginPlan {
  validatePlugins(list, true)
  const byId = new Map(list.map((p) => [p.id, p]))
  const off = new Map<string, string>()
  for (const p of list) {
    if (p.problem) off.set(p.id, p.problem)
    const missing = p.requires?.find(id => !byId.has(id))
    if (missing) off.set(p.id, `缺少依赖「${missing}」`)
  }
  for (const id of disabled) {
    const p = byId.get(id)
    if (p && !p.required) off.set(id, '已停用')
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const p of list) {
      if (off.has(p.id)) continue
      const dep = p.requires?.find((id) => off.has(id))
      if (dep) {
        off.set(p.id, `需要「${byId.get(dep)!.title}」`)
        changed = true
      }
    }
  }
  return { enabled: new Set(list.filter((p) => !off.has(p.id)).map((p) => p.id)), off }
}

/** 明确声明为可选的协作，只有具体贡献或 System 写了 needs 才受影响。 */
export interface PluginNeeds { needs?: string[] }

/** 注册前检查 ID 和具体协作的依赖声明，停用不能掩盖错误。 */
export function validateContributions<T extends { id: string }>(plugins: T[], keys: readonly string[], manifest?: PluginInfo[]): void {
  const ids = new Set<string>()
  const seen = new Map<string, string>()
  for (const p of plugins) {
    if (ids.has(p.id)) throw new Error(`插件 ID 重复：${p.id}`)
    ids.add(p.id)
    const def = manifest?.find((m) => m.id === p.id)
    if (manifest && !def && p.id !== 'host') throw new Error(`插件 ${p.id} 未声明`)
    for (const [key, values] of Object.entries(p)) {
      if (!Array.isArray(values)) continue
      for (const value of values) {
        if (typeof value !== 'object' || value === null) continue
        if (keys.includes(key)) {
          if (typeof value.id !== 'string' || !value.id) throw new Error(`插件 ${p.id} 的 ${key} 缺少 ID`)
          const token = `${key}:${value.id}`
          if (seen.has(token)) throw new Error(`${key} ID 重复：${value.id}（${seen.get(token)}、${p.id}）`)
          seen.set(token, p.id)
        }
        for (const dep of (value as PluginNeeds).needs ?? []) {
          if (manifest && dep !== p.id && !def?.requires?.includes(dep) && !def?.optional?.includes(dep)) {
            throw new Error(`插件 ${p.id} 的 ${key} 依赖 ${dep} 未在 plugin.json 声明`)
          }
        }
      }
    }
  }
}

/** 不修改原始声明；相同优先级的贡献继续保持目录清单顺序。 */
export function selectContributions<T extends { id: string }>(plugins: T[], enabled: ReadonlySet<string>): T[] {
  return plugins.filter((p) => p.id === 'host' || enabled.has(p.id)).map((p) => Object.fromEntries(
    Object.entries(p).map(([key, value]) => [key, Array.isArray(value)
      ? value.filter((item: PluginNeeds) => !item.needs?.some((dep) => !enabled.has(dep)))
      : value])
  ) as T)
}
