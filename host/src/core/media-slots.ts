import type { AcquireMediaSlot, MediaPriority, MediaWorkload } from '../shared/media-slots'

export interface MediaSlotReply { type: 'media-slot-reply'; ticket: number; error?: string }
export class CoreMediaSlots {
  private next = 0
  private readonly waiting = new Map<number, (reply: MediaSlotReply) => void>()
  constructor(private readonly send: (msg: { type: string; ticket: number; priority?: MediaPriority; workload?: MediaWorkload }) => void) {}
  reply(message: MediaSlotReply) { this.waiting.get(message.ticket)?.(message) }

  acquire: AcquireMediaSlot = async (signal, priority, workload, promotion) => {
    signal.throwIfAborted()
    const ticket = ++this.next
    return new Promise((resolve, reject) => {
      const release = () => this.send({ type: 'media-slot-release', ticket })
      const promote = () => this.send({ type: 'media-slot-promote', ticket })
      const abort = () => { promotion?.removeEventListener('abort', promote); this.waiting.delete(ticket); release(); reject(signal.reason) }
      this.waiting.set(ticket, reply => {
        this.waiting.delete(ticket)
        signal.removeEventListener('abort', abort)
        promotion?.removeEventListener('abort', promote)
        if (reply.error) reject(Error(reply.error))
        else resolve(release)
      })
      signal.addEventListener('abort', abort, { once: true })
      this.send({ type: 'media-slot-request', ticket, priority: promotion?.aborted ? 'interactive' : priority, workload })
      promotion?.addEventListener('abort', promote, { once: true })
    })
  }
}
