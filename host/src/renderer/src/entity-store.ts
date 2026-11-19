// 按可见身份合并读取；缓存、失效与生命周期属于宿主，不属于插件。
import type { EntitySource, EntityState } from '../../plugin-api/ui/entities'
import type { CoreClient } from '../../plugin-api/core'

const loading: EntityState = { status: 'loading' }
export class EntityCache implements EntitySource {
  private readonly snapshots = new Map<string, EntityState>()
  private readonly versions = new Map<string, number>()
  private readonly subs = new Map<string, Set<() => void>>()
  private wanted = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly off: () => void
  private closed = false

  constructor(private readonly core: Pick<CoreClient, 'get' | 'on'>) {
    this.off = core.on('changed', ({ ids }) => {
      for (const id of ids) {
        const previous = this.versions.get(id)
        if (previous !== undefined) this.versions.set(id, previous + 1)
        if (this.subs.has(id)) this.want(id)
        else this.snapshots.delete(id)
      }
    })
  }
  getSnapshot = (id: string): EntityState => this.snapshots.get(id) ?? loading
  get(id: string) { return this.snapshots.get(id)?.view }

  subscribe = (id: string, fn: () => void): (() => void) => {
    if (this.closed) return () => {}
    let set = this.subs.get(id)
    if (!set) this.subs.set(id, (set = new Set()))
    set.add(fn)
    const state = this.snapshots.get(id)
    if (!state || state.status === 'error') this.want(id)
    let active = true
    return () => {
      if (!active) return
      active = false
      set.delete(fn)
      if (!set.size && this.subs.get(id) === set) { this.subs.delete(id); this.wanted.delete(id) }
    }
  }
  private want(id: string): void {
    if (this.closed) return
    this.wanted.add(id)
    this.timer ??= setTimeout(() => void this.fetch(), 16)
  }
  private async fetch(): Promise<void> {
    const ids = [...this.wanted]
    const versions = new Map(ids.map((id) => {
      const version = (this.versions.get(id) ?? 0) + 1
      this.versions.set(id, version)
      return [id, version]
    }))
    this.wanted.clear()
    this.timer = undefined
    if (!ids.length || this.closed) return
    const current = (id: string) => !this.closed && this.subs.has(id) && versions.get(id) === (this.versions.get(id) ?? 0)
    try {
      const views = new Map((await this.core.get(ids)).map((v) => [v.id, v]))
      for (const id of ids) {
        if (!current(id)) continue
        const view = views.get(id)
        this.snapshots.set(id, view ? { status: 'ready', view } : { status: 'missing' })
        this.notify(id)
      }
    } catch (error) {
      for (const id of ids) {
        if (!current(id)) continue
        this.snapshots.set(id, { status: 'error', view: this.get(id), error: error instanceof Error ? error.message : String(error) })
        this.notify(id)
      }
    }
  }
  private notify(id: string): void { this.subs.get(id)?.forEach((fn) => fn()) }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.off()
    clearTimeout(this.timer)
    this.wanted.clear()
    this.subs.clear()
    this.snapshots.clear()
    this.versions.clear()
  }
}
