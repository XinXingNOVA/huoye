import { z } from 'zod'

const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/)
/** 可持久化的责任声明；不接受 SQL、路径通配符或卸载回调。 */
export const dataLifecycleSchema = z.object({
  version: z.literal(1),
  /** 拥有这些块的独立身份可以随插件清除；混合数据／外部引用仍由宿主保护。 */
  disposableRecords: z.array(z.string().min(1).max(200)).max(100).default([]),
  /** 对共享数据、外部服务等影响的说明。第一版只报告，不能据此删除别人的数据。 */
  retainedEffects: z.array(z.string().min(1).max(500)).max(30).default([])
}).strict()
export type DataLifecycle = z.input<typeof dataLifecycleSchema>
export const pluginDataRequestSchema = z.object({ pluginId, mode: z.enum(['derived', 'all']) }).strict()
export type PluginDataRequest = z.infer<typeof pluginDataRequestSchema>
export const pluginDataCleanupSchema = pluginDataRequestSchema.extend({ token: z.string().regex(/^[a-f0-9]{64}$/) })
export type PluginDataCleanupInput = z.infer<typeof pluginDataCleanupSchema>
export const pluginDataRetrySchema = z.object({ pluginId }).strict()
export interface PluginDataInfo {
  pluginId: string
  title: string
  enabled: boolean
  protected: boolean
  declared: boolean
  kinds: string[]
  persistentBlocks: number
  derivedBlocks: number
  hasSchemaContract: boolean
  pendingCaches: number
}
export interface PluginDataPreview extends PluginDataRequest {
  token: string
  blocked: string[]
  blocks: number
  removedKinds: { id: string; title: string; blocks: number }[]
  entities: number
  /** 不删除身份，只摘除附加块的素材数量。 */
  preservedEntities: number
  cacheFiles: number
  historyOperations: number
  reviewBatches?: number
  resetSchema: boolean
  retained: { id: string; reason: string }[]
  retainedEffects: string[]
}
export interface PluginDataCleanupResult extends PluginDataRequest {
  token: string
  blocks: number
  removedKinds: { id: string; title: string; blocks: number }[]
  entities: number
  historyOperations: number
  reviewBatches?: number
  resetSchema: boolean
  removedCaches: number
  pendingCaches: { reference: string; error: string }[]
  retainedCaches: string[]
  retained: PluginDataPreview['retained']
  retainedEffects: string[]
}
