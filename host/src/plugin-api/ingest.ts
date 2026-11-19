import { z } from 'zod'
import type { BlockData, Blocks } from '../shared/blocks'

/** 导入时的业务意图；键是插件发布的能力 ID，不是任意数据块名。 */
export const ingestMetadataSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/), z.unknown())
  .refine(value => Object.keys(value).length <= 20, '每项最多指定 20 种导入附加能力')
  .refine(value => { try { return JSON.stringify(value).length <= 128000 } catch { return false } }, '导入附加内容必须为有界 JSON（最多 128000 字符）')
export type IngestMetadata = Record<string, unknown>
export type IngestOutcome = 'created' | 'existing' | 'restored'
export interface IngestMetadataResult { status: 'applied' | 'unchanged' | 'preserved'; message?: string }
export interface IngestEntitySnapshot {
  id: string
  deleted: boolean
  /** 只含请求的数据块；缺失的块不返回。副本可检查，修改不会写回。 */
  blocks: Blocks
}
export interface IngestMetadataContext {
  id: string
  outcome: IngestOutcome
  /** 当前素材最新块的独立副本，不可借此修改仓库。 */
  blocksOf(): Blocks
  /** 提交事务内按 ID 检查其他实体；不存在返回 null。最多 20 个 kind，空数组只读状态。 */
  readEntity(id: string, kinds: string[]): IngestEntitySnapshot | null
  /** 只允许修改当前素材上本插件的持久普通数据块；不开放原文件、派生块或管理记录。 */
  put(kind: string, data: BlockData): void
}
export interface IngestMetadataDefinition {
  id: string
  title: string
  description: string
  input: z.ZodType<Record<string, unknown>>
  /** 同步执行，和收录同事务；不能发网络请求或启动后台写入。 */
  apply(ctx: IngestMetadataContext, input: Record<string, unknown>): IngestMetadataResult
}
export interface IngestMetadataDescription {
  id: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
}
