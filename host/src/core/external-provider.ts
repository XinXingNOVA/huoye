import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { InstalledPackage } from '../shared/external-plugins'
import { run } from '../plugin-api/core/process'
import { MAX_PROVIDER_BYTES, type ImageArtifact } from './provider-transfer'

/** Worker 负责解释结果；本次调用启动的原生程序由核心持有并等待退出。 */
export async function invokeProvider(pack: InstalledPackage, capability: string, input: unknown, sourcePath: string | undefined,
  signal: AbortSignal, progress: (fraction: number) => void, programs?: ReadonlyMap<string, string>, artifact?: ImageArtifact): Promise<unknown> {
  signal.throwIfAborted()
  const built = join(__dirname, 'provider-worker.js')
  const source = !existsSync(built)
  const worker = new Worker(source ? join(__dirname, 'provider-worker.ts') : built, {
    ...(source ? { execArgv: ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'] } : {}),
    workerData: {
      entry: join(pack.directory, pack.manifest.entries.provider!), plugin: pack.manifest.id,
      provides: pack.manifest.capabilities!.provides, resident: pack.manifest.capabilities!.implementations?.filter(p => p.via === 'service').map(p => p.id), capability, sourcePath, input, artifact
    },
    resourceLimits: { maxOldGenerationSizeMb: 128 }
  })
  const closing = new AbortController()
  const lifetime = AbortSignal.any([signal, closing.signal])
  let running: Promise<void> | undefined
  let remaining = MAX_PROVIDER_BYTES, calls = 0
  async function command(program: unknown, args: unknown) {
    const path = typeof program === 'string' && programs?.get(program)
    if (!path || !Array.isArray(args) || args.length > 128 ||
        args.some(v => typeof v !== 'string' || v.length > 8192 || v.includes('\0'))) {
      throw Error('[PROVIDER_COMMAND_INVALID] 程序未声明或参数无效')
    }
    if (++calls > 32 || remaining <= 0) throw Error('[CAPABILITY_OUTPUT_LIMIT] 单次加工的原生调用超限')
    const bytes = await run(path, args, { signal: lifetime, maxOutputBytes: remaining, processGroup: true })
    remaining -= bytes.byteLength
    lifetime.throwIfAborted()
    const data = Uint8Array.from(bytes)
    worker.postMessage({ bytes: data }, [data.buffer])
  }
  let timer: NodeJS.Timeout | undefined
  const abort = () => {
    worker.postMessage('cancel')
    timer = setTimeout(() => { void worker.terminate() }, 250)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('exit', code => reject(signal.aborted ? signal.reason : Error('[PROVIDER_EXIT] 引擎提前退出 ' + code)))
      worker.on('message', message => {
        if (signal.aborted) {
          if (!message?.command && typeof message?.progress !== 'number') reject(signal.reason)
          return
        }
        if (message?.command === true) {
          if (running) { reject(Error('[PROVIDER_BUSY] 同一调用内须依次运行原生程序')); return }
          running = command(message.program, message.args).catch(error => {
            if (!lifetime.aborted) worker.postMessage({ error: error instanceof Error ? error.message : String(error) })
          }).finally(() => { running = undefined })
        } else if (typeof message?.progress === 'number') progress(message.progress)
        else if (artifact && message?.artifact instanceof Uint8Array && message.artifact.length <= MAX_PROVIDER_BYTES) resolve(message.artifact)
        else if (!artifact && typeof message?.json === 'string') {
          try { resolve(JSON.parse(message.json)) } catch { reject(Error('[CAPABILITY_INVALID_OUTPUT] 无效的引擎结果')) }
        } else reject(Error(message?.error || '[PROVIDER_INVALID] 无效的引擎响应'))
      })
    })
  } finally {
    closing.abort()
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await Promise.all([running, worker.terminate()])
  }
}
