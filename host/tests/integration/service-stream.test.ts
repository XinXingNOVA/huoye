import { afterEach, expect, it, vi } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { serveStream } from '../../src/main/service-stream'
import { ServiceRuntime } from '../../src/main/service-runtime'
import type { LocalServiceContext, LocalServicePlugin, ServiceStreamContext } from '../../src/plugin-api/local-service'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function channel(run: (context: ServiceStreamContext) => Promise<void>, timeout = 1000) {
  const { port1, port2 } = new MessageChannel(), controller = new AbortController(), messages: any[] = []
  port2.on('message', message => messages.push(message))
  serveStream({ send: value => port1.postMessage(value),
    onMessage: fn => { port1.on('message', fn); return () => { port1.off('message', fn) } },
    onClose: fn => { port1.on('close', fn); return () => { port1.off('close', fn) } },
    close: () => port1.close(), start: () => port1.start()
  }, controller.signal, run, timeout)
  cleanups.push(() => { controller.abort(); port2.close() })
  return { controller, messages, send: (value: unknown) => port2.postMessage(value), close: () => port2.close() }
}
it('先 ready 再输出；逐段确认保持顺序，慢消费者不会积累结果，完成只发一个终态', async () => {
  let calls = 0
  const ch = channel(async ({ emit }) => { calls++; await emit({ delta: 'first' }); await emit({ delta: 'second' }) })
  expect(calls).toBe(0); ch.send({ type: 'ready' }); ch.send({ type: 'ready' })
  await vi.waitFor(() => expect(ch.messages).toHaveLength(1))
  expect(ch.messages[0]).toMatchObject({ type: 'data', sequence: 1, value: { delta: 'first' } })
  ch.send({ type: 'ack', sequence: 90 }); await new Promise(r => setTimeout(r, 20)); expect(ch.messages).toHaveLength(1)
  ch.send({ type: 'ack', sequence: 1 }); await vi.waitFor(() => expect(ch.messages).toHaveLength(2))
  expect(ch.messages[1].value).toEqual({ delta: 'second' })
  ch.send({ type: 'ack', sequence: 2 }); await vi.waitFor(() => expect(ch.messages.at(-1).type).toBe('done'))
  expect(calls).toBe(1); expect(ch.messages).toHaveLength(3)
})
it('用户取消、服务重载、断开都会中断生产者；不会发送迟到结果', async () => {
  for (const stop of ['cancel', 'reload', 'close']) {
    let signal: AbortSignal | undefined, finished = false
    const ch = channel(async ctx => { signal = ctx.signal; try { await ctx.emit('pending') } finally { finished = true } })
    ch.send({ type: 'ready' }); await vi.waitFor(() => expect(ch.messages).toHaveLength(1))
    if (stop === 'cancel') ch.send({ type: 'cancel' }); else if (stop === 'reload') ch.controller.abort(); else ch.close()
    await vi.waitFor(() => expect(finished).toBe(true)); expect(signal?.aborted).toBe(true)
    expect(ch.messages.filter(m => m.type === 'data')).toHaveLength(1)
  }
})
it('未消费超时、过大输出和生产者抛错均清理连接', async () => {
  const hung = channel(async ({ emit }) => { await emit('pending') }, 20)
  hung.send({ type: 'ready' }); await vi.waitFor(() => expect(hung.messages.at(-1)?.error).toContain('SERVICE_TIMEOUT'))
  const large = channel(async ({ emit }) => { await emit('x'.repeat(65537)) })
  large.send({ type: 'ready' }); await vi.waitFor(() => expect(large.messages.at(-1)?.error).toContain('64 KB'))
  const failed = channel(async () => { throw new Error('example failed') })
  failed.send({ type: 'ready' }); await vi.waitFor(() => expect(failed.messages.at(-1)?.error).toBe('example failed'))
})
it('服务取消不等待无响应的插件，迟到输出被拒绝；新实例不接手旧调用', async () => {
  let emit!: ServiceStreamContext['emit'], finish!: () => void
  const plugin: LocalServicePlugin = { id: 'one', start() { return { async stream(_m, _i, ctx) { emit = ctx.emit; await new Promise<void>(resolve => { finish = resolve }) } } } }
  const runtime = new ServiceRuntime<LocalServiceContext>([plugin], () => ({ library: { id: 'a', root: '/a' }, settings: {} as any, secrets: {} as any }))
  await runtime.start(new Set(['one'])); const stream = runtime.stream('one', 'run', {}, { signal: new AbortController().signal, emit: async () => {} })
  const assertion = expect(stream).rejects.toThrow('SERVICE_CANCELLED')
  await vi.waitFor(() => expect(emit).toBeTypeOf('function'))
  await runtime.stop(); await assertion
  await expect(emit('late')).rejects.toThrow(); finish()
  await expect(runtime.stream('one', 'run', {}, { signal: new AbortController().signal, emit: async () => {} })).rejects.toThrow()
})
