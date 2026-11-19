/// <reference lib="dom" />
/// <reference path="../../src/renderer/src/env.d.ts" />
import { afterEach, expect, it, vi } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { streamService } from '../../src/renderer/src/service-stream'
const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
function fixture() {
  let id = ''
  const window = Object.assign(new EventTarget(), { bridge: { services: { stream: vi.fn(async (value: string) => { id = value }) } } })
  vi.stubGlobal('window', window)
  const { port1, port2 } = new MessageChannel(), messages: any[] = []
  port2.on('message', value => messages.push(value))
  close.push(() => { port1.close(); port2.close() })
  return { messages, send: (value: unknown) => port2.postMessage(value), connect() {
    window.dispatchEvent(Object.assign(new Event('message'), { source: window, data: { type: 'service:port', id }, ports: [port1] }))
  }, invoke: window.bridge.services.stream }
}
it('建立端口前取消会关闭迟到端口，不启动服务', async () => {
  const f = fixture(), controller = new AbortController()
  const result = streamService('demo', 'run', {}, { signal: controller.signal, onData() { throw new Error('must not consume') } })
  const assertion = expect(result).rejects.toThrow('SERVICE_CANCELLED')
  controller.abort(); await assertion; f.connect()
  await vi.waitFor(() => expect(f.messages).toEqual([{ type: 'cancel' }]))
})
it('预先取消不创建连接；异步消费者完成后才确认，并能正常完成', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await expect(streamService('demo', 'run', {}, { signal: controller.signal, onData() {} })).rejects.toThrow('SERVICE_CANCELLED')
  expect(f.invoke).not.toHaveBeenCalled()
  let complete!: () => void
  const data = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
  const result = streamService('demo', 'run', {}, { onData: data }); f.connect()
  await vi.waitFor(() => expect(f.messages).toEqual([{ type: 'ready' }]))
  f.send({ type: 'data', sequence: 1, value: 'first' }); await vi.waitFor(() => expect(data).toHaveBeenCalledWith('first'))
  expect(f.messages).toHaveLength(1); complete()
  await vi.waitFor(() => expect(f.messages[1]).toEqual({ type: 'ack', sequence: 1 }))
  f.send({ type: 'done' }); await result
})
it('消费者抛错（包括空值）不会被当作成功，并取消生产者', async () => {
  const f = fixture()
  const result = streamService('demo', 'run', {}, { onData() { throw undefined } })
  const assertion = expect(result).rejects.toThrow('undefined')
  f.connect(); f.send({ type: 'data', sequence: 1, value: null }); await assertion
  await vi.waitFor(() => expect(f.messages.at(-1)).toEqual({ type: 'cancel' }))
})
