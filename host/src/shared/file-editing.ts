import { z } from 'zod'
import type { EditorOptions, LocalEditor, OpenEditingOptions } from './local-editors'
import type { PrepareFileEdit, FileEditResult } from './file-edits'

export type EditDestination = PrepareFileEdit['destination']
export const editingId = z.string().uuid()
export const startEditingSchema = z.object({ id: z.string().min(1).max(200), source: z.string().min(1).optional() }).strict()
export const checkEditingSchema = z.object({ taskId: editingId, destination: z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('publish') }).strict(), z.object({ mode: z.literal('copy'), spaceId: editingId }).strict()
]) }).strict()
export const finishEditingSchema = checkEditingSchema.partial({ destination: true })
export interface FileEditingTask {
  id: string; itemId: string; name: string; createdAt: number; updatedAt: number; ended: boolean
  baseReference: string; baseOrdinal?: number; canOpen: boolean; format: string; destination?: EditDestination
  phase: 'editing' | 'preparing' | 'ready' | 'saving' | 'pending' | 'cleanup' | 'unadopted'
  cleanupReason?: 'saved' | 'discarded'
  error?: string; lastResult?: FileEditResult
  prepared?: { token: string; hash: string; size: number; destination: EditDestination; reference: string; sample?: string }
}
export interface EditingCheck { task: FileEditingTask; unchanged: boolean }
export interface EditingEndCheck { token: string; changed: boolean; problem?: string }
/** 本机编辑任务按当前窗口仓库限定；不接收任意仓库或原件写入路径。 */
export interface FileEditingService {
  /** 列表是本机状态快照；订阅只通知失效，不代表磁盘内容被自动扫描。 */
  list(): Promise<FileEditingTask[]>
  start(input: { id: string }): Promise<FileEditingTask>
  /** 原生选择一个替换文件并创建副本；取消不创建，不接收或返回路径。 */
  chooseReplacement(id: string): Promise<FileEditingTask | null>
  editorOptions(taskId: string): Promise<EditorOptions>
  /** 显示原生应用选择器；用户选择后登记，取消返回 null。 */
  chooseEditor(): Promise<LocalEditor | null>
  /** 省略 editorId 使用当前仓库该格式偏好，再回退到受限的系统关联。只打开工作副本。 */
  open(taskId: string, options?: OpenEditingOptions): Promise<void>
  reveal(taskId: string): Promise<void>
  check(input: z.infer<typeof checkEditingSchema>): Promise<EditingCheck>
  commit(taskId: string, token: string): Promise<FileEditingTask>
  discardPrepared(taskId: string): Promise<FileEditingTask>
  inspectEnd(taskId: string): Promise<EditingEndCheck>
  /** 保存、接纳并清理；失败保留登记，重复调用接续原请求。null 表示已完成。 */
  finish(input: z.infer<typeof finishEditingSchema>): Promise<FileEditingTask | null>
  /** 明确放弃未提交修改并清理；已有空间版本不会撤销。 */
  discard(taskId: string, token: string): Promise<void>
  onChanged(listener: () => void): () => void
}

/** 替换文件选择由宿主界面负责；公共服务不接收替换路径。 */
export interface FileEditingBridge extends FileEditingService {
  start(input: z.infer<typeof startEditingSchema>): Promise<FileEditingTask>
}
