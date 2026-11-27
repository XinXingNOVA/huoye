import { z } from 'zod'
import { querySchema } from './query-input'

export interface ViewImportCandidate {
  sourceIndex: number
  /** 目录展开后的文件；bytes/text 继续使用调用方保留的输入。 */
  path?: string
  title: string
  status: 'matched' | 'unmatched' | 'unknown' | 'error'
  reason?: string
}
export const viewImportOptionsSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  query: querySchema,
  viewId: z.string().min(1).max(128).optional(),
  /** 本次输入下标：用户明确允许即使未匹配也收录。默认空集合。 */
  allowUnmatched: z.array(z.number().int().nonnegative()).default([])
}).strict()
export type ViewImportOptions = z.input<typeof viewImportOptionsSchema>
