import type { ServiceContext, ServiceInstance } from '../plugin-api/service'
import type { ServiceStreamContext } from '../plugin-api/local-service'

interface ServiceScope {
  signal: AbortSignal
  track<T>(task: Promise<T>): Promise<T>
}

/** 生命周期本身不依赖 Electron，窗口／核心进程由适配层提供。 */
export class ServiceRuntime<C extends Pick<ServiceContext, 'signal' | 'onDispose'> = ServiceContext> {
  private controller = new AbortController()
  private instances = new Map<string, ServiceInstance>()
  private errors = new Map<string, string>()
  private cleanups: (() => void | Promise<void>)[] = []
  private pending = new Set<Promise<unknown>>()
  private starting?: Promise<void>
  private stopping?: Promise<void>

  constructor(private plugins: { id: string; start(context: C): ServiceInstance | Promise<ServiceInstance> }[], private context: (id: string, scope: ServiceScope) => Omit<C, 'signal' | 'onDispose'>) {}
  get signal() { return this.controller.signal }
  problem(id: string) { return this.errors.get(id) }
  track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => {})
    return task
  }
  start(enabled: ReadonlySet<string>): Promise<void> {
    return this.starting ??= this.activate(enabled)
  }
  private async activate(enabled: ReadonlySet<string>) {
    for (const plugin of this.plugins) {
      if (this.signal.aborted) break
      if (!enabled.has(plugin.id)) continue
      const controller = new AbortController()
      const revoke = () => controller.abort()
      this.signal.addEventListener('abort', revoke, { once: true })
      const cleanups: (() => void | Promise<void>)[] = []
      const release = async () => {
        for (const dispose of cleanups.splice(0).reverse()) await this.dispose(dispose)
        this.signal.removeEventListener('abort', revoke)
      }
      try {
        const scope: ServiceScope = { signal: controller.signal, track: task => this.track(task) }
        const instance = await plugin.start({ ...this.context(plugin.id, scope), signal: controller.signal, onDispose: (fn: () => void | Promise<void>) => {
          // 运行期间新取得的资源也归本实例；失效后的迟到资源立即释放。
          if (controller.signal.aborted) void this.track(this.dispose(fn))
          else cleanups.push(fn)
        } } as C)
        this.cleanups.push(release)
        if (!this.signal.aborted) this.instances.set(plugin.id, instance)
      } catch (error) {
        controller.abort()
        this.errors.set(plugin.id, error instanceof Error ? error.message : String(error))
        await release()
      }
    }
  }
  async compute(id: string, capability: string, params: import('../shared/image-reads').CapabilityValues, lifetime: AbortSignal) {
    const signal = AbortSignal.any([this.signal, lifetime])
    signal.throwIfAborted()
    return this.track(new Promise<import('../shared/image-reads').CapabilityValues>((resolve, reject) => {
      const cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      Promise.resolve(this.starting).then(() => {
        signal.throwIfAborted()
        const instance = this.instances.get(id)
        if (!instance?.compute) throw Error('[SERVICE_UNAVAILABLE] ' + (this.errors.get(id) ?? '服务没有计算入口'))
        return instance.compute(capability, params, signal)
      })
        .then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    }))
  }
  async invoke(id: string, method: string, input?: unknown): Promise<unknown> {
    if (this.signal.aborted) throw new Error('[SERVICE_UNAVAILABLE] 服务正在关闭／重新加载')
    await this.starting
    const instance = this.instances.get(id)
    if (this.signal.aborted || !instance) throw new Error(`[SERVICE_UNAVAILABLE] ${this.errors.get(id) ?? '插件未启用或服务不可用'}`)
    if (!instance.invoke) throw new Error('这个服务没有界面调用入口')
    return this.track(Promise.resolve().then(() => {
      if (this.signal.aborted) throw new Error('[SERVICE_UNAVAILABLE] 服务正在关闭／重新加载')
      return instance.invoke!(method, input)
    }))
  }
  /** 持续调用与普通事务调用分开；取消后拒绝迟到输出，不转交给重载后的实例。 */
  async stream(id: string, method: string, input: unknown, context: ServiceStreamContext): Promise<void> {
    await this.starting
    const instance = this.instances.get(id)
    const signal = AbortSignal.any([this.signal, context.signal])
    signal.throwIfAborted()
    if (!instance?.stream) throw new Error(`[SERVICE_UNAVAILABLE] ${this.errors.get(id) ?? '服务未启用或没有持续调用入口'}`)
    await this.track(new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', cancel)
      const cancel = () => { cleanup(); reject(new Error('[SERVICE_CANCELLED] 持续调用已取消')) }
      signal.addEventListener('abort', cancel, { once: true })
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return instance.stream!(method, input, {
          signal,
          emit: async value => { signal.throwIfAborted(); await context.emit(value); signal.throwIfAborted() }
        })
      }).then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
    }))
  }
  stop(): Promise<void> {
    // 先同步撤销访问，再等待已有任务及启动收尾，绝不把旧调用转交给新核心。
    this.controller.abort()
    return this.stopping ??= (async () => {
      await this.starting
      this.instances.clear()
      for (const dispose of this.cleanups.splice(0).reverse()) await this.dispose(dispose)
      await Promise.allSettled([...this.pending])
    })()
  }
  private async dispose(fn: () => void | Promise<void>) {
    try { await fn() } catch (error) { console.error('[service cleanup]', error) }
  }
}
