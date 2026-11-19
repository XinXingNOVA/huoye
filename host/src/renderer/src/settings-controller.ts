import type { SettingsGuard, SettingsLeaveIntent, SettingsPage, SettingsService, SettingsSnapshot, SettingsTarget } from '../../plugin-api/ui/settings'

/** 每所属会话一份，附属设置窗口共享；只协调导航与表单退出，不拥有配置数据，不依赖 React 或标签页。 */
export class SettingsController implements SettingsService {
  private snapshot: SettingsSnapshot = Object.freeze({ revision: 0, busy: false })
  private listeners = new Set<() => void>()
  private guards = new Map<string, SettingsGuard>()
  private lifetime = new AbortController()
  constructor(private catalog: () => readonly SettingsPage[], private present: (target: Required<SettingsTarget>) => void, private defaultScope: 'application' | 'library' = 'library') {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  pages = () => this.catalog().map(p => ({ ...p, keywords: p.keywords && [...p.keywords] }))
  private update(patch: Partial<SettingsSnapshot>) { this.snapshot = Object.freeze({ ...this.snapshot, ...patch }); this.listeners.forEach(fn => fn()) }
  private resolve(target: SettingsTarget): Required<SettingsTarget> {
    const pages = this.catalog()
    if (target.scope !== undefined && !['application', 'library'].includes(target.scope)) throw new Error('设置范围无效')
    const matches = pages.filter(p => (!target.scope || p.scope === target.scope) && (!target.section || p.id === target.section))
    const page = target.section ? matches[0] : matches.find(p => p.scope === (target.scope ?? this.defaultScope))
    if (!page || (target.section && matches.length !== 1)) throw new Error('设置页面不可用，请检查插件是否启用')
    return { scope: page.scope, section: page.id }
  }
  registerGuard = (id: string, guard: SettingsGuard) => {
    if (this.lifetime.signal.aborted) throw new Error('设置服务已关闭')
    if (this.guards.has(id)) throw new Error(`设置退出检查重复：${id}`)
    this.guards.set(id, guard)
    return () => { if (this.guards.get(id) === guard) this.guards.delete(id) }
  }
  private async approve(guard: SettingsGuard, intent: SettingsLeaveIntent, signal: AbortSignal): Promise<boolean> {
    if (!guard.beforeLeave) return false
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return guard.beforeLeave!(intent, signal) }), cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  private async check(intent: SettingsLeaveIntent, signal: AbortSignal): Promise<boolean> {
    for (const [id, guard] of this.guards) {
      signal.throwIfAborted()
      const state = guard.state()
      if (state.busy || (state.dirty && !(await this.approve(guard, intent, signal)))) {
        this.update({ blockedReason: state.message ?? (state.busy ? '设置正在保存，请稍候' : `请先处理未保存的设置：${id}`) })
        return false
      }
      signal.throwIfAborted()
    }
    return true
  }
  private async transition(action: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal) {
    if (this.snapshot.busy) return false
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    this.update({ busy: true, blockedReason: undefined })
    try { return await action(combined) } finally { this.update({ busy: false }) }
  }
  open = (target: SettingsTarget = {}): Promise<boolean> => this.transition(async signal => {
    const resolved = this.resolve(target)
    const old = this.snapshot.target
    if ((!old || old.scope !== resolved.scope || old.section !== resolved.section) && !await this.check({ reason: 'navigate', target: resolved }, signal)) return false
    signal.throwIfAborted()
    this.resolve(resolved) // 等待表单确认后重新检查目录。
    this.present(resolved)
    this.update({ target: Object.freeze(resolved), revision: this.snapshot.revision + 1 })
    return true
  })
  beforeLeave = (intent: SettingsLeaveIntent, signal?: AbortSignal) => this.transition(s => this.check(intent, s), signal)
  dispose() { this.lifetime.abort(); this.guards.clear(); this.listeners.clear() }
}
