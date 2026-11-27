import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServiceRuntime } from '../../src/main/service-runtime'
import type { ServicePlugin } from '../../src/plugin-api/service'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
function fixture() {
  const create = (plugins: ServicePlugin[]) => {
    const signals = new Map<string, AbortSignal>()
    const runtime = new ServiceRuntime(plugins, (id, scope) => {
      signals.set(id, scope.signal)
      return { library: { id: 'one', root: '/test-library' }, executable: () => ({ command: 'test', args: [], env: {} }) }
    })
    cleanups.push(() => runtime.stop())
    return { runtime, signals }
  }
  return { create }
}

describe('仓库服务生命周期', () => {
  it('启动期间的计算等待服务就绪，已取消的请求不会交给插件', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const compute = vi.fn(async () => ({ count: 3 }))
    const { runtime } = fixture().create([{ id: 'engine', async start() {
      await gate
      return { compute }
    } }])
    const starting = runtime.start(new Set(['engine']))
    const cancelled = new AbortController()
    const request = (signal: AbortSignal) => runtime.compute('engine', 'example/text.count@1', {}, signal)
    const pending = request(new AbortController().signal)
    const rejected = expect(request(cancelled.signal)).rejects.toThrow('cancelled')
    cancelled.abort(new Error('cancelled'))
    try { await rejected; expect(compute).not.toHaveBeenCalled() }
    finally { finish() }
    await starting
    await expect(pending).resolves.toEqual({ count: 3 })
    expect(compute).toHaveBeenCalledTimes(1)
  })
  it('只启动启用项，各实例独立，重复停止只清理一次，停止后拒绝界面调用', async () => {
    const f = fixture(), events: string[] = []
    const plugin: ServicePlugin = { id: 'demo', start(ctx) {
      events.push('start'); ctx.onDispose(() => { events.push('first') }); ctx.onDispose(() => { events.push('last') })
      let count = 0
      return { invoke: () => ++count }
    } }
    const a = f.create([plugin]).runtime, b = f.create([plugin]).runtime, disabled = f.create([plugin]).runtime
    await a.start(new Set(['demo'])); await b.start(new Set(['demo'])); await disabled.start(new Set())
    expect(events).toEqual(['start', 'start'])
    expect(await a.invoke('demo', 'count')).toBe(1)
    expect(await a.invoke('demo', 'count')).toBe(2)
    expect(await b.invoke('demo', 'count')).toBe(1)
    await expect(disabled.invoke('demo', 'count')).rejects.toThrow('未启用')
    await Promise.all([a.stop(), a.stop()])
    expect(events).toEqual(['start', 'start', 'last', 'first'])
    await expect(a.invoke('demo', 'count')).rejects.toThrow('SERVICE_UNAVAILABLE')
    expect(await b.invoke('demo', 'count')).toBe(2)
  })

  it('启动失败释放已取得的资源，不阻止其他服务，停止会等待正在启动的服务', async () => {
    const f = fixture(), released = vi.fn(), laterReleased = vi.fn()
    let laterStarted = false
    let finish!: () => void
    const delayed = new Promise<void>(resolve => { finish = resolve })
    const broken: ServicePlugin = { id: 'broken', start(ctx) { ctx.onDispose(released); throw new Error('启动失败') } }
    const later: ServicePlugin = { id: 'later', async start(ctx) { ctx.onDispose(laterReleased); laterStarted = true; await delayed; return {} } }
    const { runtime } = f.create([broken, later])
    const starting = runtime.start(new Set(['broken', 'later']))
    await vi.waitFor(() => expect(laterStarted).toBe(true))
    expect(released).toHaveBeenCalledOnce()
    const stopping = runtime.stop()
    expect(runtime.signal.aborted).toBe(true)
    finish(); await starting; await stopping
    expect(laterReleased).toHaveBeenCalledOnce()
  })

  it('停止同步撤销信号并等待已派发调用，不把旧调用转给新实例', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const started = vi.fn()
    const f = fixture(), { runtime, signals } = f.create([{ id: 'demo', start: () => ({
      invoke: async () => { started(); await pending; return 'old' }
    }) }])
    await runtime.start(new Set(['demo']))
    const request = runtime.invoke('demo', 'run')
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    expect(signals.get('demo')!.aborted).toBe(true)
    await expect(runtime.invoke('demo', 'run')).rejects.toThrow('SERVICE_UNAVAILABLE')
    await Promise.resolve(); expect(stopped).toBe(false)
    const next = f.create([{ id: 'demo', start: () => ({ invoke: () => 'new' }) }]).runtime
    await next.start(new Set(['demo']))
    expect(await next.invoke('demo', 'run')).toBe('new')
    finish(); expect(await request).toBe('old'); await stopping
  })

  it('启动失败的插件单独撤销访问，成功插件仍工作；运行中登记的资源也会清理', async () => {
    const f = fixture(), released = vi.fn()
    const plugins: ServicePlugin[] = [
      { id: 'broken', start() { throw new Error('broken') } },
      { id: 'live', start(ctx) { return { invoke: () => { ctx.onDispose(released); return true } } } }
    ]
    const { runtime, signals } = f.create(plugins)
    await runtime.start(new Set(['broken', 'live']))
    expect(signals.get('broken')!.aborted).toBe(true)
    expect(signals.get('live')!.aborted).toBe(false)
    expect(await runtime.invoke('live', 'allocate')).toBe(true)
    await runtime.stop()
    expect(released).toHaveBeenCalledOnce()
  })
})
