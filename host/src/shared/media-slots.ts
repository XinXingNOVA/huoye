export type MediaPriority = 'interactive' | 'background'
export type MediaWorkload = 'light' | 'heavy' | 'read'
export type AcquireMediaSlot = (signal: AbortSignal, priority?: MediaPriority, workload?: MediaWorkload, promotion?: AbortSignal) => Promise<() => void>

/** 同级按到达顺序交接，连续四个交互请求后给后台一次机会。 */
export class MediaSlots {
  private active = 0
  private streak = 0
  private readonly queues = { background: new Set<() => void>(), interactive: new Set<() => void>() }
  constructor(private readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error('无效的并发数')
  }
  private handoff() {
    const { interactive, background } = this.queues
    const urgent = interactive.size > 0 && (!background.size || this.streak < 4)
    this.streak = urgent ? Math.min(4, this.streak + 1) : 0
    const queue = urgent ? interactive : background
    queue.values().next().value?.()
  }
  acquire: AcquireMediaSlot = async (signal, priority = 'background', _workload, promotion) => {
    signal.throwIfAborted()
    let queue = this.queues[promotion?.aborted ? 'interactive' : priority]
    if (this.queues.background.size + this.queues.interactive.size >= 256 || (queue === this.queues.background && queue.size >= 240)) {
      throw Error('[CAPABILITY_BUSY] 重任务队列已满')
    }
    return new Promise((resolve, reject) => {
      const promote = () => {
        if (!queue.delete(grant)) return
        queue = this.queues.interactive
        queue.add(grant)
      }
      const cancel = () => { queue.delete(grant); promotion?.removeEventListener('abort', promote); reject(signal.reason) }
      const grant = () => {
        queue.delete(grant)
        signal.removeEventListener('abort', cancel)
        promotion?.removeEventListener('abort', promote)
        this.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.active--
          this.handoff()
        })
      }
      if (this.active < this.limit) grant()
      else { queue.add(grant); promotion?.addEventListener('abort', promote, { once: true }); signal.addEventListener('abort', cancel, { once: true }) }
    })
  }
}
