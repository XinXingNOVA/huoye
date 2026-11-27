import { imageTransports } from '../core-client'
import type { UiHost } from '../plugin'
import type { PageCapabilities, PageImageReads } from '../../../shared/image-reads'

export function pageImageReads(core: UiHost['core'], url: UiHost['url'], plugin: string, enabled = true) {
  const releases = new Set<() => void>()
  let closed = !enabled
  const reads: PageImageReads = {
    async image(capability, input, options = {}) {
      options.signal?.throwIfAborted()
      if (closed) throw Error('[CAPABILITY_EXPIRED] 阅读页面已关闭')
      const transport = imageTransports.get(core)
      if (!transport) throw Error('[LIBRARY_OFFLINE] 仓库未连接')
      const lease = crypto.randomUUID()
      const release = () => {
        if (!releases.delete(release)) return
        options.signal?.removeEventListener('abort', release)
        void transport.release(lease).catch(() => {})
      }
      releases.add(release)
      options.signal?.addEventListener('abort', release, { once: true })
      try {
        const info = await transport.acquire({ plugin, capability, input, lease, maxEdge: options.maxEdge, priority: options.priority ?? 'display' })
        if (!releases.has(release)) throw Error('[CAPABILITY_EXPIRED] 读取已取消')
        return { ...info, url: url('_reads/' + lease), release }
      } catch (error) { release(); throw error }
    }
  }
  const capabilities: PageCapabilities = {
    async inspect(id) {
      if (closed) throw Error('[CAPABILITY_EXPIRED] 页面已关闭')
      const transport = imageTransports.get(core)
      if (!transport) throw Error('[LIBRARY_OFFLINE] 仓库未连接')
      return transport.inspect(plugin, id)
    },
    async run(id, params, options = {}) {
      options.signal?.throwIfAborted()
      if (closed) throw Error('[CAPABILITY_EXPIRED] 页面已关闭')
      const transport = imageTransports.get(core)
      if (!transport) throw Error('[LIBRARY_OFFLINE] 仓库未连接')
      const ticket = crypto.randomUUID()
      const cancel = () => {
        if (releases.delete(cancel)) void transport.cancel(ticket).catch(() => {})
      }
      releases.add(cancel)
      options.signal?.addEventListener('abort', cancel, { once: true })
      try {
        const value = await transport.run(ticket, plugin, id, params)
        if (!releases.has(cancel)) throw Error('[CAPABILITY_EXPIRED] 计算已取消')
        return value
      } finally { releases.delete(cancel); options.signal?.removeEventListener('abort', cancel) }
    }
  }
  return { reads, capabilities, open() { closed = false }, close() { closed = true; for (const release of releases) release() } }
}
