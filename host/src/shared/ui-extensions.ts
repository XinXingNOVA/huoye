import type { UiExtension, UiExtensionContribution, UiExtensionDiagnostic, UiExtensionPoint, UiExtensions } from '../plugin-api/ui/extension-types'
import type { PluginInfo } from './plugin-plan'

export interface UiExtensionDeclarations {
  id: string
  extensionPoints?: UiExtensionPoint[]
  extensions?: UiExtensionContribution[]
}
const namespaced = (id: unknown, owner?: string): id is string => typeof id === 'string' && id.length <= 150 && /^[a-z][a-z0-9-]*\.[a-zA-Z0-9_.-]+$/.test(id) && (!owner || id.startsWith(owner + '.'))
const validVersion = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0
const key = (point: string, version: number) => `${point}@${version}`
const empty: readonly UiExtension[] = Object.freeze([])
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000)

/** 仅查声明形状和依赖，不执行校验器或要求目标已加载；可以用于逐包预检。 */
export function validateUiExtensionDeclarations(plugins: readonly UiExtensionDeclarations[], manifest: readonly PluginInfo[]): void {
  const points = new Set<string>(), ids = new Set<string>()
  for (const p of plugins) {
    const info = manifest.find(m => m.id === p.id)
    for (const field of ['extensionPoints', 'extensions'] as const) {
      if (p[field] !== undefined && (!Array.isArray(p[field]) || p[field]!.length > 256)) throw new Error(`插件 ${p.id} 的 ${field} 声明无效`)
    }
    for (const point of p.extensionPoints ?? []) {
      if (!point || !namespaced(point.id, p.id) || !validVersion(point.version) || typeof point.validate !== 'function') throw new Error(`插件 ${p.id} 的扩展点声明无效`)
      const token = key(point.id, point.version)
      if (points.has(token)) throw new Error(`扩展点重复：${token}`)
      points.add(token)
    }
    for (const c of p.extensions ?? []) {
      if (!c || !namespaced(c.id, p.id) || !namespaced(c.point) || !validVersion(c.version) || (c.order !== undefined && !Number.isFinite(c.order)) ||
          (c.needs !== undefined && (!Array.isArray(c.needs) || c.needs.length > 30 || c.needs.some(d => typeof d !== 'string') || new Set(c.needs).size !== c.needs.length))) throw new Error(`插件 ${p.id} 的扩展贡献声明无效`)
      if (ids.has(c.id)) throw new Error(`扩展贡献重复：${c.id}`)
      ids.add(c.id)
      const owner = c.point.split('.')[0]
      for (const dep of new Set([owner, ...c.needs ?? []])) {
        if (dep !== p.id && dep !== 'host' && !info?.requires?.includes(dep) && !info?.optional?.includes(dep)) throw new Error(`贡献 ${c.id} 未声明对 ${dep} 的依赖`)
      }
    }
  }
}

/** 实例按仓库窗口装配；只索引声明，不保存页面上下文或执行业务动作。 */
export class UiExtensionRegistry implements UiExtensions {
  private readonly lists = new Map<string, readonly UiExtension[]>()
  private readonly entries = new Set<UiExtension>()
  private issues: readonly UiExtensionDiagnostic[] = Object.freeze([])
  private readonly listeners = new Set<() => void>()

  constructor(plugins: readonly UiExtensionDeclarations[], manifest: readonly PluginInfo[], enabled: ReadonlySet<string>) {
    validateUiExtensionDeclarations(plugins, manifest)
    const live = (id: string) => id === 'host' || enabled.has(id)
    const active = plugins.filter(p => live(p.id))
    const points = new Map(active.flatMap(p => (p.extensionPoints ?? []).map(point => [key(point.id, point.version), { pluginId: p.id, point }] as const)))
    const candidates = new Map<string, { pluginId: string; c: UiExtensionContribution }[]>()
    for (const p of active) for (const c of p.extensions ?? []) {
      if (!live(c.point.split('.')[0]) || c.needs?.some(id => !live(id))) continue
      const token = key(c.point, c.version)
      if (!points.has(token)) {
        this.addIssue({ pluginId: p.id, id: c.id, point: c.point, version: c.version, phase: 'resolve', message: '提供方未声明此扩展点或契约版本不匹配' })
        continue
      }
      const list = candidates.get(token) ?? []
      list.push({ pluginId: p.id, c }); candidates.set(token, list)
    }
    for (const [token, { pluginId, point }] of points) {
      const accepted: UiExtension[] = []
      const sorted = [...candidates.get(token) ?? []].sort((a, b) => (a.c.order ?? 0) - (b.c.order ?? 0) || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
      for (const { pluginId: contributor, c } of sorted) {
        try {
          const issue: unknown = point.validate(c.value)
          if (issue !== undefined && typeof issue !== 'string') {
            // JS 插件也可能误写异步校验器；拒绝该点，并消费拒绝以免泄漏未处理异常。
            if (issue && typeof (issue as PromiseLike<unknown>).then === 'function') void Promise.resolve(issue).catch(() => {})
            throw new Error('扩展点校验必须同步返回 undefined 或问题文字')
          }
          if (issue !== undefined) {
            this.addIssue({ pluginId: contributor, id: c.id, point: c.point, version: c.version, phase: 'validate', message: issue.slice(0, 2000) || '贡献载荷不符合契约' })
          } else accepted.push(Object.freeze({ pluginId: contributor, id: c.id, point: c.point, version: c.version, value: c.value }))
        } catch (error) {
          this.addIssue({ pluginId, id: point.id, point: point.id, version: point.version, phase: 'validate', message: `提供方校验器出错：${errorText(error)}` })
          accepted.length = 0 // 不发布一个校验器故障的点的部分结果。
          break
        }
      }
      accepted.forEach(entry => this.entries.add(entry))
      this.lists.set(token, Object.freeze(accepted))
    }
  }
  list = <T = unknown>(point: string, version: number): readonly UiExtension<T>[] => (this.lists.get(key(point, version)) ?? empty) as readonly UiExtension<T>[]
  diagnostics = () => this.issues
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private addIssue(issue: UiExtensionDiagnostic): void {
    const same = (previous: UiExtensionDiagnostic) => previous.pluginId === issue.pluginId && previous.id === issue.id && previous.point === issue.point && previous.version === issue.version && previous.phase === issue.phase && previous.message === issue.message
    if (this.issues.some(same)) return
    this.issues = Object.freeze([...this.issues.slice(-99), Object.freeze(issue)])
    this.listeners.forEach(listener => listener())
  }
  private requireEntry(extension: UiExtension): void {
    if (!this.entries.has(extension)) throw new Error('贡献不属于当前窗口的有效目录')
  }
  reportFailure = (extension: UiExtension, error: unknown, phase: 'render' | 'action'): void => {
    this.requireEntry(extension)
    this.addIssue({ pluginId: extension.pluginId, id: extension.id, point: extension.point, version: extension.version, phase, message: errorText(error) })
  }
  invoke = async <T, R>(extension: UiExtension<T>, action: (value: T) => R): Promise<Awaited<R>> => {
    this.requireEntry(extension)
    try { return await action(extension.value) }
    catch (error) { this.reportFailure(extension, error, 'action'); throw error }
  }
}
