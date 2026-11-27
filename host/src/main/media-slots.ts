import type { UtilityProcess } from 'electron'
import { MediaSlots } from '../shared/media-slots'

const applicationSlots = new MediaSlots()
const readSlots = new MediaSlots(2)
const lightSlots = new MediaSlots(2)

/** 按进程分开保存请求，跨库共享优先级队列；核心退出时收回它尚未归还的所有名额。 */
export function serveMediaSlots(core: UtilityProcess, pool = applicationSlots) {
  const held = new Map<number, { lifetime: AbortController; promotion: AbortController; release?: () => void }>()
  function finish(id: number) {
    const job = held.get(id)
    if (!job) return
    held.delete(id)
    job.lifetime.abort()
    job.release?.()
  }
  function reply(ticket: number, error?: string) {
    try { core.postMessage({ type: 'media-slot-reply', ticket, error }) }
    catch { finish(ticket) } // 核心可能正在退出。
  }
  function message(msg: { type: string; ticket: number; priority?: string; workload?: string }) {
    const id = msg.ticket
    if (!Number.isSafeInteger(id) || id < 1) return
    if (msg.type === 'media-slot-promote') return held.get(id)?.promotion.abort()
    if (msg.type === 'media-slot-release') return finish(id)
    if (msg.type !== 'media-slot-request' || held.has(id)) return
    const lifetime = new AbortController()
    const promotion = new AbortController()
    held.set(id, { lifetime, promotion })
    const queue = msg.workload === 'read' ? readSlots : msg.workload === 'light' ? lightSlots : pool
    void queue.acquire(lifetime.signal, msg.priority === 'interactive' ? 'interactive' : 'background', undefined, promotion.signal).then(release => {
      const job = held.get(id)
      if (!job || lifetime.signal.aborted) { release(); return }
      job.release = release
      reply(id)
    }).catch(error => {
      if (lifetime.signal.aborted) return
      finish(id)
      reply(id, error instanceof Error ? error.message : String(error))
    })
  }
  core.on('message', message)
  core.once('exit', () => {
    core.off('message', message)
    for (const id of held.keys()) finish(id)
  })
}
