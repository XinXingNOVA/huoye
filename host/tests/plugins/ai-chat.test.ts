import { afterEach, expect, it, vi } from 'vitest'
import { openHost } from '../helpers/helpers'
import { corePlugins } from '../../src/plugins/core'
import { plugin } from '@test-plugins/ai-chat/core'
import { plugin as service, endpointOf } from '@test-plugins/ai-chat/service'
import { readCompletion } from '@test-plugins/ai-chat/protocol'
import { KIND, promptMessages, transcript } from '@test-plugins/ai-chat/model'
import type { SavedConversation } from '@test-plugins/ai-chat/model'
import type { LocalServiceContext, LocalServiceInstance } from '../../src/plugin-api/local-service'
import { ChatSession } from '@test-plugins/ai-chat/session'
import type { UiHost } from '../../src/plugin-api/ui/contracts'
let current: ReturnType<typeof openHost> | undefined
afterEach(() => { current?.cleanup(); current = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })
const setup = () => (current = openHost([...corePlugins, plugin])).host
const ref = { sourceId: 'source', text: '选中文字', locator: { provider: 'text.quote', version: 1, data: { quote: '选中文字', prefix: '', suffix: '', offset: 0 } } }
const begin = (h: ReturnType<typeof setup>, args = {}) => h.api.run('ai-chat', 'begin', { requestId: 'req-1', text: '解释一下', reference: ref, ...args }) as SavedConversation
it('对话记录独立于素材，引用快照保留；两次短事务，停止部分回答与删除均可撤销', async () => {
  const h = setup(), a = begin(h)
  expect((await h.api.query({})).ids).not.toContain(a.id)
  expect(a.messages.at(-1)?.status).toBe('pending'); expect(a.messages[0].reference).toEqual(ref)
  const b = h.api.run('ai-chat', 'finish', { id: a.id, seq: a.seq, requestId: 'req-1', text: '部分回答', status: 'stopped', model: 'test' }) as SavedConversation
  expect(b.messages.at(-1)).toMatchObject({ text: '部分回答', status: 'stopped' })
  expect(transcript(b)).toContain('选中文字'); expect(transcript(b)).toContain('部分回答')
  h.api.undo(); expect(h.store.blocksOf(a.id)[KIND].data.messages).toEqual(a.messages)
  h.api.redo(); h.api.run('ai-chat', 'delete', { id: a.id }); expect(h.store.exists(a.id)).toBe(false)
  h.api.undo(); expect(h.store.blocksOf(a.id)[KIND].data.messages).toEqual(b.messages)
})
it('拒绝过期写入、误写其他记录、超长问题；撤销／删除后的迟到回答不复活记录', () => {
  const h = setup(), a = begin(h), finish = { id: a.id, seq: a.seq, requestId: 'req-1', text: 'late', status: 'complete' }
  expect(() => begin(h, { id: a.id, seq: a.seq - 1, requestId: 'req-2' })).toThrow('已变化')
  expect(() => begin(h, { text: 'x'.repeat(16001) })).toThrow()
  expect(() => begin(h, { id: 'missing' })).toThrow('不存在')
  h.api.undo(); expect(() => h.api.run('ai-chat', 'finish', finish)).toThrow('不存在')
  h.api.redo(); expect(() => h.api.run('ai-chat', 'finish', finish)).toThrow('已变化')
  h.api.run('ai-chat', 'delete', { id: a.id }); expect(() => h.api.run('ai-chat', 'finish', finish)).toThrow('不存在')
})
it('停用与重新启用保留历史；原文删除不级联删除引用快照', async () => {
  const h = setup(), source = await h.api.create({ text: { content: ref.text } }), a = begin(h, { reference: { ...ref, sourceId: source } })
  h.api.trash([source]); expect(h.store.blocksOf(a.id)[KIND]).toBeTruthy()
  const root = current!.root; h.close(); current = undefined
  const bare = openHost(corePlugins, {}, root)
  expect(bare.host.api.readItem({ id: a.id })).toBeTruthy(); bare.host.close()
  current = openHost([...corePlugins, plugin], {}, root)
  expect(current.host.store.blocksOf(a.id)[KIND].data.messages).toEqual(a.messages)
})
it('只发送消息文字与显式引用，不发送定位数据／仓库路径；超长上下文明确拒绝', () => {
  const h = setup(), a = begin(h), prompt = promptMessages(a.messages)
  expect(prompt).toHaveLength(1); expect(prompt[0].content).toContain('选中文字')
  expect(JSON.stringify(prompt)).not.toContain('offset'); expect(JSON.stringify(prompt)).not.toContain('sourceId')
  expect(() => promptMessages(Array(4).fill({ ...a.messages[0], text: 'x'.repeat(64000) }))).toThrow('超过')
})
const bytes = (value: string, split = false) => new ReadableStream<Uint8Array>({ start(c) { const b = new TextEncoder().encode(value); if (split) for (const byte of b) c.enqueue(new Uint8Array([byte])); else c.enqueue(b); c.close() } })
const frame = (text: string) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\r\n\r\n'
it('SSE 支持任意 UTF8/CRLF 分片、注释、多行数据、终止与空 usage；拒绝断流和超大事件', async () => {
  const events: unknown[] = []
  await readCompletion(bytes(': keepalive\r\n\r\n' + frame('你好😀') + 'data: {"choices":[],\r\ndata: "usage":{}}\r\n\r\ndata: [DONE]\r\n\r\n', true), async e => { events.push(e) })
  expect(events).toEqual([{ type: 'delta', text: '你好😀' }, { type: 'done', finishReason: 'stop' }])
  await expect(readCompletion(bytes(frame('部分')), async () => {})).rejects.toThrow('提前结束')
  await expect(readCompletion(bytes('data: ' + 'x'.repeat(131073)), async () => {})).rejects.toThrow('过大')
  await expect(readCompletion(bytes('data: {broken}\n\n'), async () => {})).rejects.toThrow('无法解析')
  await expect(readCompletion(bytes('data: {"error":{"message":"secret"}}\n\n'), async () => {})).rejects.toThrow('模型服务返回错误')
})
function fakeService() {
  const settings = new Map<string, any>(), secrets = new Map<string, string>()
  const ctx = { library: { id: 'test', root: '/test' }, signal: new AbortController().signal, onDispose() {},
    settings: { get: (_: unknown, k: string) => settings.get(k), set: (_: unknown, k: string, v: unknown) => settings.set(k, v), remove: (_: unknown, k: string) => settings.delete(k) },
    secrets: { available: () => true, has: (_: unknown, k: string) => secrets.has(k), get: (_: unknown, k: string) => secrets.get(k), set: (_: unknown, k: string, v: string) => secrets.set(k, v), remove: (_: unknown, k: string) => secrets.delete(k) }
  } as LocalServiceContext
  return service.start(ctx) as LocalServiceInstance
}
it('配置不返回密钥，密钥与端点绑定；同模型地址可复用，换地址不泄露旧 key，拒绝凭据 URL', async () => {
  const s = fakeService(), config = { endpoint: 'https://api.example.test/v1', model: 'example', key: 'private-test-key' }
  expect(s.invoke!('configure', config)).toMatchObject({ hasKey: true }); expect(JSON.stringify(s.invoke!('settings', null))).not.toContain('private-test-key')
  s.invoke!('configure', { endpoint: 'https://other.example.test/v1', model: 'example' })
  expect(s.invoke!('settings', null)).toMatchObject({ hasKey: false })
  expect(s.invoke!('settings', null)).toMatchObject({ storedKey: true })
  let authorization: string | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => { authorization = options.headers.Authorization; return new Response(bytes(frame('ok') + 'data: [DONE]\n\n'), { headers: { 'Content-Type': 'text/event-stream' } }) }))
  await s.stream!('chat', { messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal, emit: async () => {} })
  expect(authorization).toBeUndefined()
  expect(() => endpointOf('https://user:password@example.com')).toThrow('凭据')
  expect(() => endpointOf('http://example.com/v1')).toThrow('HTTPS')
  expect(endpointOf('http://127.0.0.1:123/v1/')).toBe('http://127.0.0.1:123/v1/chat/completions')
  expect(s.invoke!('clearKey', null)).toMatchObject({ hasKey: false, storedKey: false })
})
it('不自动重试网络/HTTP 错误且不回显密钥；主动停止取消 fetch；同库并发被拒绝', async () => {
  const s = fakeService(); s.invoke!('configure', { endpoint: 'https://example.test/v1', model: 'test' })
  const fetcher = vi.fn(async () => { throw new Error('private-test-key https://secret.example.test') }); vi.stubGlobal('fetch', fetcher)
  const args = { messages: [{ role: 'user', content: 'test' }] }, options = { signal: new AbortController().signal, emit: async () => {} }
  await expect(s.stream!('chat', args, options)).rejects.toThrow('无法连接模型接口'); expect(fetcher).toHaveBeenCalledTimes(1)
  const abort = new AbortController(); let requestSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => { requestSignal = options.signal; requestSignal!.addEventListener('abort', () => reject(Error('aborted'))) })))
  const running = s.stream!('chat', args, { ...options, signal: abort.signal })
  await vi.waitFor(() => expect(requestSignal).toBeTruthy())
  await expect(s.stream!('chat', args, options)).rejects.toThrow('已有回答')
  abort.abort(); await expect(running).rejects.toThrow('已停止'); expect(requestSignal!.aborted).toBe(true)
})
it('UI 会话停止后保存部分文字，窗口卸载中断但不误写，重复发送不会重复请求', async () => {
  const h = setup(), listeners = new Set<(e: { ids: string[] }) => void>(); let onData: (v: any) => void = () => {}; let signal: AbortSignal | undefined
  const run = vi.fn(async (p, c, a) => h.api.run(p, c, a))
  const host = { core: { query: async (q: any) => h.api.query(q), get: async (ids: string[]) => h.api.get(ids), run, on: (_e: string, fn: any) => { listeners.add(fn); return () => listeners.delete(fn) } },
    service: async () => ({ model: 'test' }), streamService: vi.fn((_p, _m, _a, o) => { onData = o.onData; signal = o.signal; return new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(Error('stop')))) })
  } as unknown as UiHost
  const session = new ChatSession(host); session.mount(); await vi.waitFor(() => expect(session.snapshot().loading).toBe(false))
  session.setDraft('问题'); const sending = session.send(); void session.send()
  await vi.waitFor(() => expect(host.streamService).toHaveBeenCalledTimes(1)); onData({ type: 'delta', text: '部分' }); session.stop(); await sending
  expect(session.snapshot().current?.messages.at(-1)).toMatchObject({ text: '部分', status: 'stopped' })
  session.setDraft('再问'); const second = session.send(); await vi.waitFor(() => expect(host.streamService).toHaveBeenCalledTimes(2))
  const calls = run.mock.calls.length; session.dispose(); await second; expect(signal!.aborted).toBe(true); expect(run.mock.calls.length).toBe(calls)
  expect(listeners.size).toBe(0)
})
it('服务重载取消保留中断状态；保存冲突保留内存回答并阻止误覆盖，未自动重新请求', async () => {
  const h = setup()
  let conflict = false
  const host = { core: { query: async (q: any) => h.api.query(q), get: async (ids: string[]) => h.api.get(ids),
    run: async (p: string, c: string, a: any) => { if (conflict && c === 'finish') throw Error('对话已变化'); return h.api.run(p, c, a) }, on: () => () => {} },
    service: async () => ({ model: 'test' }),
    streamService: vi.fn(async (_p, _m, _a, o) => { o.onData({ type: 'delta', text: '保留部分内容' }); throw Error('[SERVICE_CANCELLED] 服务已停止或重载') })
  } as unknown as UiHost
  const s = new ChatSession(host); s.mount(); await vi.waitFor(() => expect(s.snapshot().loading).toBe(false))
  s.setDraft('问题'); await s.send(); expect(s.snapshot().current?.messages.at(-1)).toMatchObject({ status: 'interrupted', text: '保留部分内容' })
  conflict = true; s.setDraft('再问'); await s.send(); expect(s.snapshot().unsaved?.text).toBe('保留部分内容')
  s.newChat(); expect(s.snapshot().current).toBeTruthy(); s.setDraft('不能误发送'); await s.send(); expect(host.streamService).toHaveBeenCalledTimes(2)
  conflict = false; await s.retrySave(); expect(s.snapshot().unsaved).toBeUndefined(); expect(host.streamService).toHaveBeenCalledTimes(2); s.dispose()
})
it('模型无响应超时会取消网络，失败后可重新手动发送', async () => {
  vi.useFakeTimers()
  const s = fakeService(); s.invoke!('configure', { endpoint: 'https://example.test/v1', model: 'test' })
  let aborted = false
  vi.stubGlobal('fetch', vi.fn((_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => { aborted = true; reject(Error('abort')) }))))
  const run = s.stream!('chat', { messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal, emit: async () => {} })
  const result = expect(run).rejects.toThrow('响应超时')
  await vi.advanceTimersByTimeAsync(120001); await result; expect(aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
