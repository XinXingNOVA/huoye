// 界面一侧的核心进程客户端：经 MessagePort 调用 CoreApi，接收事件。

import type { RpcEvent, RpcResponse } from '../../shared/rpc'
import type { FacetItem } from '../../shared/query'

import type { CoreClient } from '../../plugin-api/core'
export type { CoreClient } from '../../plugin-api/core'

export function connectCore(): Promise<CoreClient> {
  return new Promise((resolve, reject) => {
    const disconnected = new AbortController()
    let connected = false
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      window.removeEventListener('unload', cleanup)
    }
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window) return
      if (ev.data === 'core:offline') {
        cleanup(); disconnected.abort(); reject(offlineError())
      } else if (ev.data === 'core:port' && !connected) {
        connected = true; clearTimeout(timer)
        resolve(createCoreClient(ev.ports[0], disconnected.signal))
      }
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('[TIMEOUT] 仓库连接超时，请重新打开仓库')) }, 15000)
    window.addEventListener('message', onMessage)
    window.addEventListener('unload', cleanup)
    try { window.bridge.connectCore() } catch (error) { cleanup(); reject(error) }
  })
}

const offlineError = () => new Error('[LIBRARY_OFFLINE] 仓库后台已退出，请重新加载仓库。已发出的写入结果需重新核对，不会自动重试。')
// 只限制短只读请求；导入、编辑等写操作不能以读取超时误报失败或自动重试。
const boundedReads = new Set(['listSpaceFiles', 'listFileSpaces'])
export function createCoreClient(port: MessagePort, disconnected: AbortSignal): CoreClient {
  let nextId = 1
  let offline = false
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const close = () => {
    if (offline) return
    offline = true
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(offlineError()) }
    pending.clear(); listeners.clear(); port.close()
    disconnected.removeEventListener('abort', close)
  }
  disconnected.addEventListener('abort', close, { once: true })
  if (disconnected.aborted) close()
  port.onmessageerror = close

  port.onmessage = (ev) => {
    const msg = ev.data as RpcResponse | RpcEvent
    if ('event' in msg) {
      listeners.get(msg.event)?.forEach((fn) => fn(msg.payload))
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(msg.id)
    if ('error' in msg) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }

  const on = (event: string, fn: (payload: unknown) => void) => {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  const request = <T>(method: string, args: unknown[]) => new Promise<T>((resolve, reject) => {
    if (offline) { reject(offlineError()); return }
    const id = nextId++
    const timer = boundedReads.has(method) ? setTimeout(() => {
      pending.delete(id); reject(new Error('[TIMEOUT] 文件空间读取超时，可点击“检查并刷新”重试；不会重复执行文件处置。'))
    }, 15000) : undefined
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    try { port.postMessage({ id, method, args }) } catch { close() }
  })

  // 多个筛选面板可在同一次 React 提交中请求完全相同的分桶。只合并同步发起的读取。
  const facets = new Map<string, Promise<FacetItem[]>>()
  const facet: CoreClient['facet'] = async (...args) => {
    if (offline) throw offlineError()
    const key = JSON.stringify(args)
    let result = facets.get(key)
    if (!result) {
      if (!facets.size) queueMicrotask(() => facets.clear())
      result = request<FacetItem[]>('facet', args)
      facets.set(key, result)
    }
    // 各插件可以重排或修改返回项，保持原有 RPC 的独立结果语义。
    return (await result).map(item => ({ ...item }))
  }

  return new Proxy({} as CoreClient, {
    get: (_target, prop: string) => {
      if (prop === 'on') return on
      if (prop === 'then') return undefined // 避免被当作 Promise
      if (prop === 'facet') return facet
      return (...args: unknown[]) => {
        // 穿插的操作可能已经改变数据；同一调用栈中随后发出的统计也须重新读取。
        if (prop !== 'query' && prop !== 'get' && prop !== 'getIdentities') facets.clear()
        return request(prop, args)
      }
    }
  })
}
