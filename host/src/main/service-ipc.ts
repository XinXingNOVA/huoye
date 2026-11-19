import { ipcMain, MessageChannelMain } from 'electron'
import { libraryOf } from './libraries'
import { trustedWindow } from './trusted-window'
import { checkServiceInput, serveStream } from './service-stream'
import type { ServiceRuntime } from './service-runtime'

export function registerServiceIpc(): void {
  const connections = new WeakMap<ServiceRuntime, Set<Electron.MessagePortMain>>()
  const from = (event: Electron.IpcMainInvokeEvent, plugin: unknown, method: unknown, input: unknown) => {
    trustedWindow(event)
    const lib = libraryOf(event.sender)
    if (!lib?.services || lib.reloading || typeof plugin !== 'string' || plugin.length > 80 || typeof method !== 'string' || !method || method.length > 100) throw new Error('请在仓库窗口调用已启用的服务')
    checkServiceInput(input)
    return lib.services
  }
  ipcMain.handle('services:invoke', (event, plugin: unknown, method: unknown, input: unknown) => from(event, plugin, method, input).invoke(plugin as string, method as string, input))
  ipcMain.handle('services:stream', (event, id: unknown, plugin: unknown, method: unknown, input: unknown) => {
    const runtime = from(event, plugin, method, input)
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('连接 ID 无效')
    const active = connections.get(runtime) ?? new Set<Electron.MessagePortMain>()
    if (active.size >= 16) throw new Error('本仓库持续调用过多，请停止部分请求后重试')
    connections.set(runtime, active)
    const { port1, port2 } = new MessageChannelMain()
    active.add(port1)
    serveStream({
      send: value => port1.postMessage(value),
      onMessage: listener => { const fn = (e: Electron.MessageEvent) => listener(e.data); port1.on('message', fn); return () => port1.off('message', fn) },
      onClose: listener => { port1.on('close', listener); return () => port1.off('close', listener) },
      start: () => port1.start(),
      close: () => { active.delete(port1); port1.close() }
    }, runtime.signal, context => runtime.stream(plugin as string, method as string, input, context))
    try { event.senderFrame!.postMessage('services:port', { id }, [port2]) }
    catch (error) { port2.close(); port1.close(); active.delete(port1); throw error }
  })
}
