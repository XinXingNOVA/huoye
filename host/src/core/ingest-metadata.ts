import { ingestMetadataSchema, type IngestMetadataDescription, type IngestMetadataResult, type IngestOutcome } from '../plugin-api/ingest'
import type { CorePlugin } from '../plugin-api/core/contracts'
import { jsonSchema, parseInput } from '../shared/automation'
import type { Registry } from './registry'
import type { Store } from './store'
import { z } from 'zod'

const entityReadSchema = z.object({ id: z.string().min(1).max(200), kinds: z.array(z.string().min(1).max(200)).max(20) }).strict()

export function validateIngestMetadata(plugin: CorePlugin) {
  const ids = new Set<string>()
  for (const entry of plugin.ingestMetadata ?? []) {
    if (!entry.id.startsWith(`${plugin.id}.`) || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(entry.id) || ids.has(entry.id)) throw new Error(`导入附加能力 ID 无效或重复：${entry.id}`)
    ids.add(entry.id)
    if (!entry.title?.trim() || !entry.description?.trim() || typeof entry.apply !== 'function' || jsonSchema(entry.input).type !== 'object') throw new Error(`导入附加能力声明不完整：${entry.id}`)
  }
}
export function describeIngestMetadata(reg: Registry): IngestMetadataDescription[] {
  return reg.plugins.flatMap(plugin => (plugin.ingestMetadata ?? []).map(entry => ({
    id: entry.id, title: entry.title, description: entry.description, inputSchema: jsonSchema(entry.input)
  })))
}

/** 所有输入先校验，再开始复制文件；错误不会被当成普通文件失败而静默跳过。 */
export function prepareMetadata(reg: Registry, input: unknown) {
  const metadata = parseInput(ingestMetadataSchema, input === undefined ? {} : input)
  return Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    const plugin = reg.plugins.find(p => p.ingestMetadata?.some(entry => entry.id === name))
    const entry = plugin?.ingestMetadata?.find(entry => entry.id === name)
    if (!plugin || !entry) throw new Error(`[UNAVAILABLE_INGEST_METADATA] 未启用的导入附加能力：${name}`)
    try { return { plugin: plugin.id, entry, input: structuredClone(parseInput(entry.input, value)) } }
    catch (error) { throw new Error(`[INVALID_INGEST_METADATA] ${name}: ${String(error)}`) }
  })
}

export function applyMetadata(reg: Registry, store: Store, id: string, outcome: IngestOutcome, plan: ReturnType<typeof prepareMetadata>) {
  const results: Record<string, IngestMetadataResult> = {}, written = new Set<string>()
  for (const step of plan) {
    let active = true
    let reads = 0, readBytes = 0
    const guard = () => { if (!active) throw new Error('导入附加上下文已经结束') }
    try {
      const result = step.entry.apply({
        id, outcome,
        blocksOf: () => { guard(); return structuredClone(store.blocksOf(id)) },
        readEntity: (target, kinds) => {
          guard()
          if (++reads > 100) throw new Error('[INGEST_READ_LIMIT] 每个处理器最多读取 100 次')
          const input = parseInput(entityReadSchema, { id: target, kinds })
          if (!store.exists(input.id)) return null
          const value = { id: input.id, deleted: store.isTrashed(input.id), blocks: store.blocksOf(input.id, input.kinds) }
          const bytes = Buffer.byteLength(JSON.stringify(value))
          readBytes += bytes
          if (bytes > 1024 * 1024 || readBytes > 4 * 1024 * 1024) throw new Error('[INGEST_READ_LIMIT] 读取超过单次 1 MiB 或累计 4 MiB，请缩小指定数据块')
          return structuredClone(value)
        },
        put: (kind, data) => {
          guard()
          const def = reg.kind(kind)
          if (!def || def.dormant || def.plugin !== step.plugin || def.rebuildable || def.management || def.standalone || def.history === false || Object.values(def.fields).some(f => f.file)) throw new Error(`导入附加能力不能写入 ${kind}`)
          if (written.has(kind)) throw new Error(`导入附加能力重复写入 ${kind}，请合并为一个业务意图`)
          store.put(id, kind, data)
          written.add(kind)
        }
      }, step.input)
      if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new Error('处理器必须同步执行')
      }
      if (!result || !['applied', 'unchanged', 'preserved'].includes(result.status) || (result.message !== undefined && (typeof result.message !== 'string' || result.message.length > 1000))) throw new Error('处理器必须同步返回有效结果')
      results[step.entry.id] = { status: result.status, ...(result.message ? { message: result.message } : {}) }
    } catch (error) { throw new Error(`[INGEST_METADATA_FAILED] ${step.entry.id}: ${String(error)}`) }
    finally { active = false }
  }
  return results
}
