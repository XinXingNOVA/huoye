import { parentPort, workerData } from 'node:worker_threads'
import type { CapabilityProvider } from '../../packages/provider-sdk'
import { MAX_PROVIDER_BYTES, type ImageArtifact } from './provider-transfer.ts'
import { pathToFileURL } from 'node:url'

const port = parentPort!
const task = workerData as {
  entry: string; plugin: string; provides: string[]; resident?: string[]; capability: string; sourcePath?: string; artifact?: ImageArtifact; input: Record<string, unknown>
}
const lifetime = new AbortController()
let reply: ((message: { bytes?: Uint8Array; error?: string }) => void) | undefined
port.on('message', message => {
  if (message === 'cancel') {
    lifetime.abort()
    reply?.({ error: '[CAPABILITY_CANCELLED] 调用已取消' })
  }
  else reply?.(message)
})
function runProgram(program: string, args: readonly string[]): Promise<Uint8Array> {
  lifetime.signal.throwIfAborted()
  if (reply) return Promise.reject(Error('[PROVIDER_BUSY] 同一调用内须依次运行原生程序'))
  return new Promise((resolve, reject) => {
    reply = message => {
      reply = undefined
      if (message.bytes instanceof Uint8Array) resolve(message.bytes)
      else reject(Error(message.error || '[PROVIDER_COMMAND_FAILED] 原生程序未返回结果'))
    }
    port.postMessage({ command: true, program, args })
  })
}

async function invoke() {
  const { plugin } = await import(/* @vite-ignore */ pathToFileURL(task.entry).href) as { plugin: CapabilityProvider }
  if (plugin?.id !== task.plugin || !plugin.handlers ||
    Object.keys(plugin.handlers).some(k => !task.provides.includes(k) || typeof plugin.handlers[k] !== 'function') ||
    !task.provides.every(k => task.resident?.includes(k) || Object.hasOwn(plugin.handlers, k))) {
    throw Error('[PROVIDER_INVALID] 提供者导出与包清单不一致')
  }
  lifetime.signal.throwIfAborted()
  let last = 0
  const value = await plugin.handlers[task.capability](task.input, {
    run: runProgram, sourcePath: task.sourcePath, signal: lifetime.signal, progress(fraction) {
      const now = Date.now()
      if (!lifetime.signal.aborted && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && now - last >= 150) {
        last = now
        port.postMessage({ progress: fraction })
      }
    }
  })
  lifetime.signal.throwIfAborted()
  if (task.artifact) {
    if (!(value instanceof Uint8Array) || !value.length || value.length > MAX_PROVIDER_BYTES) throw Error('[CAPABILITY_INVALID_OUTPUT] 图片须为有界二进制数据')
    const bytes = Uint8Array.from(value)
    port.postMessage({ artifact: bytes }, [bytes.buffer])
    return
  }
  const json = JSON.stringify(value)
  if (!json || Buffer.byteLength(json) > 4 * 1024 * 1024) throw Error('[CAPABILITY_OUTPUT_LIMIT] 结果超过传输限制')
  port.postMessage({ json })
}
void invoke().catch(error => port.postMessage({ error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }))
