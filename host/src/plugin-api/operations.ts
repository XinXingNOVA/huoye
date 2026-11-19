// 公共的对外能力声明；不依赖 MCP SDK，供业务插件和接入适配器共用。
import type { z } from 'zod'
import type { IngestMetadataResult } from './ingest'
import type { IngestInput } from '../shared/ingest-input'

interface OperationBase {
  name: string
  title: string
  description: string
  input: z.ZodType<Record<string, unknown>>
  /** operation-effects-v1。data 整理素材值；structure 修改模板、分类规则等结构。缺省操作不向外部开放执行。 */
  effect?: import('../shared/external-access').OperationEffect
  /** operation-review-v1。跨素材约束需要整体维护时声明 false，普通执行与会话撤销照常。 */
  reviewable?: false
}

/** 声明不授予连接权限。异步收录由宿主准备，数据、撤销与回执仍同步提交。 */
export type OperationDefinition = OperationBase & (
  | { command: string; ingest?: never }
  | { command?: never; ingest(args: Record<string, unknown>): IngestInput[] }
)

export interface IngestResult {
  items: { index: number; id: string; outcome: 'created' | 'existing' | 'restored'; metadata?: Record<string, IngestMetadataResult> }[]
  errors: { index: number; message: string }[]
  /** 导入不等待派生加工；用 read_item 查询当前 processing 与 failures。 */
  processing: 'not_waited'
}

export { parseInput, jsonSchema } from '../shared/automation'
export type { OperationDescription, ExecuteOperationRequest, OperationResult } from '../shared/automation'
