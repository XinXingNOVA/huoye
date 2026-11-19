import { importFilesSchema, type ImportReport } from './import-settings'
import { z } from 'zod'
import type { ProcessingObservation } from './processing-status'

/** 应用观察参数与核心的持久导入参数分开，不改变请求签名。 */
export const observedImportSchema = importFilesSchema.extend({
  waitMs: z.number().int().min(0).max(2000).optional(),
  processingKinds: z.array(z.string().min(1).max(200)).min(1).max(16).optional()
})
export type ObservedImportInput = z.input<typeof observedImportSchema>
export type ObservedImportReport = ImportReport & {
  processingObservation?: ({ state: 'observed' } & ProcessingObservation) | { state: 'not-collected' | 'empty' } | { state: 'unavailable'; reason: string }
}
