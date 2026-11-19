import { z } from 'zod'
import type { ProcessingSummary } from './processing-status'

export const libraryStatusSchema = z.object({
  libraryId: z.string().min(1).max(200),
  sections: z.array(z.enum(['plugins', 'workbench', 'processing', 'errors'])).max(4).default([])
}).strict()
export type LibraryStatusInput = z.input<typeof libraryStatusSchema>
export type StatusSections = z.output<typeof libraryStatusSchema>['sections']
export interface LibraryStatus {
  libraryId: string
  core: 'running' | 'closed' | 'offline' | 'reloading' | 'closing'
  workbench?: { state: 'ready' | 'loading' | 'layout-pending' | 'closed'; visible: boolean }
  plugins?: { id: string; enabled: boolean; unavailable?: string; reason?: string; version?: string; serviceError?: string }[]
  processing?: ProcessingSummary
  /** 当前装配／服务问题摘要，不是完整日志，也不包含素材加工失败。 */
  errors?: { plugin: string; message: string }[]
}
