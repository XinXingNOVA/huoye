import { z } from 'zod'

export const readPreviewSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(12),
  mode: z.enum(['single', 'grid']).default('single'),
  maxSide: z.number().int().min(256).max(1600).default(1280),
  expectedRevisions: z.record(z.string().max(200), z.string().max(100)).optional()
}).strict().refine(input => input.mode !== 'single' || input.ids.length === 1, '单图模式只能指定一个素材')
  .refine(input => !input.expectedRevisions || Object.keys(input.expectedRevisions).every(id => input.ids.includes(id)), '版本凭据只能包含本批素材')
export type ReadPreviewInput = z.input<typeof readPreviewSchema>
export interface PreviewItem {
  /** 从 1 开始，与请求顺序及拼版编号一致，失败项不挤占其他位置。 */
  index: number
  id: string
  revision: string
  state: 'ready' | 'pending' | 'missing' | 'trashed' | 'changed' | 'unsupported' | 'failed' | 'blocked' | 'unavailable'
  reason?: string
  source?: { kind: 'still' | 'thumb'; seq: number }
  /** 本库已接纳原件的版本及可用性；离线时仍可能有可用的当前缓存。 */
  original?: { state: 'available' | 'missing' | 'unavailable'; contentVersion?: string }
}
export interface PreviewResult {
  mode: 'single' | 'grid'
  items: PreviewItem[]
  /** 有界的内联 JPEG；适配层可以转换为原生图像内容，避免重复放进 JSON。 */
  image?: { mimeType: 'image/jpeg'; data: string; width: number; height: number }
}
