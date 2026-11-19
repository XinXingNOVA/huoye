import { assertLocalValue } from './plugin-local-store'
import type { ServiceStreamContext } from '../plugin-api/local-service'

/** 与 Electron 无关的传输适配，便于验证顺序、背压与断开。 */
export interface StreamPort {
  send(value: unknown): void
  onMessage(listener: (value: any) => void): () => void
  onClose(listener: () => void): () => void
  start(): void
  close(): void
}
export function checkServiceInput(value: unknown): void {
  if (value === undefined) return
  assertLocalValue(value)
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error('服务输入超过 1 MB')
}

/** 同时至多一段未确认数据；未消费超时则取消，不积累完整答案。 */
export function serveStream(port: StreamPort, signal: AbortSignal, run: (context: ServiceStreamContext) => Promise<void>, timeoutMs = 30000): void {
  const controller = new AbortController()
  let closed = false, started = false, sequence = 0
  let pending: { sequence: number; resolve(): void; reject(error: Error): void } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let offMessage = () => {}, offClose = () => {}
  const finish = (error?: string) => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    controller.abort()
    pending?.reject(new Error(error ?? '[SERVICE_CANCELLED] 通道关闭')); pending = undefined
    signal.removeEventListener('abort', stop)
    offMessage(); offClose()
    try { port.send(error ? { type: 'error', error: error.slice(0, 2000) } : { type: 'done' }) } catch { /* 页面已离开 */ }
    port.close()
  }
  const stop = () => finish('[SERVICE_CANCELLED] 服务已停止或重载')
  const deadline = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish('[SERVICE_TIMEOUT] 界面未及时消费数据，已取消'), timeoutMs) }
  offClose = port.onClose(() => finish('[SERVICE_CANCELLED] 页面连接已断开'))
  offMessage = port.onMessage(message => {
    if (closed || !message) return
    if (message.type === 'cancel') return finish('[SERVICE_CANCELLED] 已停止生成')
    if (message.type === 'ack' && pending && pending.sequence === message.sequence) {
      if (timer) clearTimeout(timer)
      const previous = pending; pending = undefined; previous.resolve()
    }
    if (message.type !== 'ready' || started) return
    started = true
    if (timer) clearTimeout(timer)
    void Promise.resolve().then(() => run({
      signal: controller.signal,
      emit(value) {
        if (closed) return Promise.reject(new Error('[SERVICE_CANCELLED] 通道关闭'))
        if (pending) { const error = '[STREAM_BACKPRESSURE] 请逐段 await emit'; finish(error); return Promise.reject(new Error(error)) }
        assertLocalValue(value)
        if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new Error('单段数据超过 64 KB，请拆分发送')
        return new Promise<void>((resolve, reject) => {
          pending = { sequence: ++sequence, resolve, reject }
          deadline()
          try { port.send({ type: 'data', sequence, value }) } catch { finish('[SERVICE_CANCELLED] 页面连接已断开') }
        })
      }
    })).then(() => finish(), error => finish(error instanceof Error ? error.message : '服务调用失败'))
  })
  signal.addEventListener('abort', stop, { once: true })
  port.start(); deadline()
  if (signal.aborted) stop()
}
