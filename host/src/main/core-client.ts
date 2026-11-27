import { MessageChannelMain, type UtilityProcess } from 'electron'
import type { CoreApi, RpcResponse } from '../shared/rpc'

/** 主进程也经同一 RPC 访问唯一写入者；重载时旧端口随调用收尾。 */
export function callCore<K extends keyof CoreApi>(core: UtilityProcess, method: K, ...args: Parameters<CoreApi[K]>): Promise<ReturnType<CoreApi[K]>> {
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannelMain()
    const done = () => { clearTimeout(timer); core.off('exit', offline); port1.close() }
    const offline = () => { done(); reject(new Error('[LIBRARY_OFFLINE] 仓库核心已关闭或正在重新加载')) }
    const timer = setTimeout(() => { done(); reject(new Error('[TIMEOUT] 核心调用超时；写入重试请保持原 requestId')) }, ['externalFileAction', 'prepareFileEdit', 'commitFileEdit', 'restoreSpaceVersion', 'mutateSpaceFiles'].includes(method) ? 120000 : 15000)
    core.once('exit', offline)
    port1.on('message', ({ data }: { data: RpcResponse }) => {
      if (data.id !== 1) return
      done()
      if ('error' in data) reject(new Error(data.error))
      else resolve(data.result as ReturnType<CoreApi[K]>)
    })
    port1.start()
    try { core.postMessage({ type: 'connect', main: true }, [port2]); port1.postMessage({ id: 1, method, args }) }
    catch { offline() }
  })
}
