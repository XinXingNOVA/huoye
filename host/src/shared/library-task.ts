import { z } from 'zod'
import type { ReviewPage } from './batch-review'

export const taskIdSchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/)
export const inputPathSchema = z.string().min(1).max(4096)
  .refine(p => p.startsWith('/') || /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\'), '请使用本机绝对路径')
  .refine(p => !p.includes('\0'), '路径不能包含空字符')
const title = z.string().trim().min(1).max(200)
const inputs = z.array(inputPathSchema).min(1).max(1000).refine(xs => new Set(xs).size === xs.length, '同一清单内路径不能重复')
const section = z.enum(['inputs', 'attempts', 'writes'])
const offset = z.number().int().nonnegative(), limit = z.number().int().min(1).max(100)
const page = { offset: offset.default(0), limit: limit.default(30) }
export const libraryTaskSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), taskId: taskIdSchema, title, inputs }).strict(),
  z.object({ action: z.literal('complete'), taskId: taskIdSchema }).strict(),
  z.object({ action: z.literal('abandon'), taskId: taskIdSchema }).strict(),
  z.object({ action: z.literal('list'), ...page }).strict(),
  z.object({ action: z.literal('diff'), taskId: taskIdSchema, requestId: taskIdSchema, ...page }).strict(),
  z.object({ action: z.literal('get'), taskId: taskIdSchema, section: section.default('inputs'), ...page }).strict()
])
export const libraryTaskToolSchema = z.object({ libraryId: z.string().min(1), action: z.enum(['list','get','create','diff','complete','abandon']),
  taskId: taskIdSchema.optional(), requestId: taskIdSchema.optional(), title: title.optional(), inputs: inputs.optional(), section: section.optional(), offset: offset.optional(), limit: limit.optional() }).strict()
export type LibraryTaskInput = z.input<typeof libraryTaskSchema>
export type TaskState = 'active' | 'completed' | 'abandoned'
export interface TaskSummary { state: TaskState; endedAt: number | null; taskId: string; title: string; created: number; inputCount: number }
export interface TaskInputStatus {
  path: string
  state: string
  requestId: string | null
  entityId: string | null
  fileId: string | null
  error: string | null
}
export interface TaskAttempt extends TaskInputStatus { attemptNo: number; requestId: string }
export interface TaskWrite { requestId: string; operation: string; reviewState: 'draft' | 'pending' | 'confirmed' | 'withdrawn' | 'unavailable' | 'discarded'; batchId: string | null }
export const taskLimitMax = { tasks: 1000, attempts: 10000, writes: 4096, drafts: 512 }
export const defaultTaskLimits = { tasks: 128, attempts: 4096, writes: 1024, drafts: 64 }
export type TaskLimits = typeof defaultTaskLimits
const bound = (max: number) => z.number().int().min(1).max(max)
export const taskLimitsSchema = z.object({
  tasks: bound(taskLimitMax.tasks), attempts: bound(taskLimitMax.attempts),
  writes: bound(taskLimitMax.writes), drafts: bound(taskLimitMax.drafts)
}).strict()
export interface TaskCapacity { limits: TaskLimits; tasks: number; drafts: number }
export interface TaskMarkerUsage { tasks: number; requests: number; estimatedBytes: number }
export const cleanupTargetSchema = z.object({ taskId: taskIdSchema, mode: z.enum(['drafts', 'records']), requestId: taskIdSchema.optional() }).strict()
  .refine(target => !target.requestId || target.mode === 'drafts', '单请求清理仅适用于草稿')
export type TaskCleanupTarget = z.infer<typeof cleanupTargetSchema>
export interface TaskCleanupPlan extends TaskCleanupTarget {
  state: TaskState
  inputs: number
  attempts: number
  errors: number
  writes: number
  drafts: number
  changes: number
  reviews: number
  preparations: number
  revision: string
}
export type LibraryTaskResult = { tasks: TaskSummary[]; capacity: TaskCapacity; nextOffset: number | null } | {
  task: TaskSummary; inputs?: TaskInputStatus[];
  draft?: { requestId: string; items: ReviewPage['items'] };
  attempts?: TaskAttempt[]; writes?: TaskWrite[]; nextOffset: number | null
}
