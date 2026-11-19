import type { StreamOptions } from '../../plugin-api/local-service'

/** 订阅先于连接，端口 ready 后才启动服务，避免首段输出竞态。 */
export function streamService(plugin: string, method: string, input: unknown, options: StreamOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = crypto.randomUUID()
    let port: MessagePort | undefined, closed = false, connecting = false, sequence = 0
    const disconnect = () => { clearTimeout(timeout); window.removeEventListener('message', connect) }
    const timeout = setTimeout(() => { connecting = false; disconnect(); finish(new Error('[SERVICE_TIMEOUT] 服务通道未建立')) }, 30000)
    const finish = (error?: Error) => {
      if (closed) return
      closed = true
      // 在端口送达前取消时，保留短暂接收器，立即关掉迟到端口；绝不发送 ready。
      if (port || !connecting) disconnect()
      options.signal?.removeEventListener('abort', cancel)
      if (port) { port.postMessage({ type: 'cancel' }); port.close() }
      if (error) reject(error); else resolve()
    }
    const cancel = () => finish(new Error('[SERVICE_CANCELLED] 持续调用已取消'))
    const connect = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'service:port' || event.data.id !== id) return
      const received = event.ports[0]
      if (!received) return finish(new Error('服务端口缺失'))
      port = received
      disconnect()
      if (closed || options.signal?.aborted) { port.postMessage({ type: 'cancel' }); port.close(); return }
      port.onmessage = async ({ data }) => {
        if (closed) return
        if (data.type === 'done') return finish()
        if (data.type === 'error') return finish(new Error(data.error))
        if (data.type !== 'data' || data.sequence !== sequence + 1) return finish(new Error('服务数据顺序异常'))
        sequence = data.sequence
        try {
          await options.onData(data.value)
          if (!closed) port!.postMessage({ type: 'ack', sequence })
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      }
      port.onmessageerror = () => finish(new Error('服务消息无法读取'))
      port.start()
      port.postMessage({ type: 'ready' })
    }
    window.addEventListener('message', connect)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) return cancel()
    connecting = true
    void window.bridge.services.stream(id, plugin, method, input).catch(error => {
      connecting = false; disconnect(); finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}
