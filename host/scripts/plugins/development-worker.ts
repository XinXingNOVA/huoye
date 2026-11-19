// 开发工程提供的构建进程，不随发布应用打包编译器；由应用通过 IPC 管理生命周期。
import { startPluginDevelopment } from './dev.ts'

type Entry = { source: string; output: string }
const watchers = new Map<string, Awaited<ReturnType<typeof startPluginDevelopment>>>()
let wanted: Entry[] = [], stopping = false, configuring = false
let builds = Promise.resolve()
const serialize = (fn: () => Promise<void>) => { const next = builds.then(fn); builds = next.catch(() => {}); return next }
const send = () => { if (process.connected) process.send?.({ type: 'changed' }) }
async function reconcile() {
  if (configuring) return
  configuring = true
  try {
    while (!stopping) {
      for (const [source, watcher] of watchers) if (!wanted.some(e => e.source === source)) { watchers.delete(source); await watcher.close() }
      const entry = wanted.find(e => !watchers.has(e.source))
      if (!entry) break
      try {
        const watcher = await startPluginDevelopment(entry.source, entry.output, { serialize, onStatus: send, log: message => console.log(message) })
        watchers.set(entry.source, watcher)
      } catch (error) {
        if (process.connected) process.send?.({ type: 'failed', source: entry.source, message: String(error) })
        wanted = wanted.filter(e => e.source !== entry.source)
      }
    }
  } finally { configuring = false; if (stopping) await stop() }
}
async function stop() {
  stopping = true
  if (configuring) return
  await Promise.all([...watchers.values()].map(w => w.close())); watchers.clear()
  process.exit(0)
}
process.on('message', (message: { type: string; entries?: Entry[] }) => {
  if (message.type === 'configure') { wanted = message.entries ?? []; void reconcile() }
  else if (message.type === 'stop') void stop()
})
process.on('disconnect', () => void stop())
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop())
process.send?.({ type: 'ready' })
