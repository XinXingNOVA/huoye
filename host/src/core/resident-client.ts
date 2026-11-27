import type { ResidentCall, ResidentCancel, ResidentReply, ResidentCompute } from '../shared/resident-capability'

export class ResidentClient {
  private next = 0
  private pending = new Map<number, (reply: ResidentReply) => void>()
  constructor(private send: (msg: ResidentCall | ResidentCancel) => void) {}
  reply(msg: ResidentReply) { this.pending.get(msg.ticket)?.(msg) }
  compute: ResidentCompute = (plugin, capability, params, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const ticket = ++this.next
    const clear = () => { this.pending.delete(ticket); signal.removeEventListener('abort', cancel) }
    const cancel = () => {
      clear()
      try { this.send({ type: 'resident-cancel', ticket }) } finally { reject(signal.reason) }
    }
    this.pending.set(ticket, msg => {
      clear()
      if (msg.error || !msg.result) reject(Error(msg.error ?? '[CAPABILITY_INVALID_OUTPUT] 缺少计算结果'))
      else resolve(msg.result)
    })
    signal.addEventListener('abort', cancel, { once: true })
    try { this.send({ type: 'resident-call', ticket, plugin, capability, params }) }
    catch (error) { clear(); reject(error) }
  })
}
