import { z } from 'zod'

export const editorIdSchema = z.union([z.literal('system'), z.string().uuid()])
export const openEditingSchema = z.object({ editorId: editorIdSchema.optional(), remember: z.boolean().optional() }).strict()
export type OpenEditingOptions = z.infer<typeof openEditingSchema>
export interface LocalEditor { id: string; title: string }
export interface RegisteredEditor extends LocalEditor { path: string }
export interface EditorOptions {
  editors: LocalEditor[]
  /** 当前仓库、实际扩展名的本机偏好；undefined 表示未指定。 */
  preferred?: string
  systemAllowed: boolean
  format: string
}
/** 只有宿主的本机设置界面管理程序路径；插件选择已登记的 ID。 */
export interface LocalEditorsBridge {
  list(): Promise<RegisteredEditor[]>
  choose(): Promise<RegisteredEditor | null>
  remove(id: string): Promise<void>
  onChanged(listener: () => void): () => void
}
