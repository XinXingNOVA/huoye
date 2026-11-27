import type { UtilityProcess } from 'electron'
import type { ResidentCall, ResidentCancel, ResidentReply } from '../shared/resident-capability'
import type { ServiceRuntime } from './service-runtime'

// The generation is tied to one core process, including while its services start.
export function serveResidentCapabilities(core: UtilityProcess) {
  const pending = new Map<number, AbortController>()
  let ready!: (runtime?: ServiceRuntime) => void
  const service = new Promise<ServiceRuntime | undefined>(resolve => { ready = resolve })
  const handle = async (msg: ResidentCall | ResidentCancel) => {
    if (msg.type === 'resident-cancel') { pending.get(msg.ticket)?.abort(); return }
    if (msg.type !== 'resident-call' || pending.has(msg.ticket)) return
    const job = new AbortController()
    pending.set(msg.ticket, job)
    const reply: ResidentReply = { type: 'resident-reply', ticket: msg.ticket }
    try {
      const runtime = await service
      job.signal.throwIfAborted()
      if (!runtime) throw Error('[SERVICE_UNAVAILABLE] 服务未启动')
      const result = await runtime.compute(msg.plugin, msg.capability, msg.params, job.signal)
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('[CAPABILITY_INVALID_OUTPUT] 计算结果须为 JSON 对象')
      let json: string
      try { json = JSON.stringify(result) }
      catch { throw Error('[CAPABILITY_INVALID_OUTPUT] 计算结果无法编码为 JSON') }
      if (!json?.startsWith('{')) throw Error('[CAPABILITY_INVALID_OUTPUT] 计算结果须为 JSON 对象')
      if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw Error('[CAPABILITY_INVALID_OUTPUT] 结果过大')
      reply.result = JSON.parse(json)
    } catch (error) {
      delete reply.result
      reply.error = error instanceof Error ? error.message : String(error)
    } finally {
      pending.delete(msg.ticket)
      if (!job.signal.aborted) { try { core.postMessage(reply) } catch { /* core exited */ } }
    }
  }
  core.on('message', handle)
  core.once('exit', () => { core.off('message', handle); for (const job of pending.values()) job.abort(); ready() })
  return ready
}
