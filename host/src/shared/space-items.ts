import { z } from 'zod'

export const spaceItemGroups = ['primary', 'attachment', 'unclassified', 'trashed'] as const
export type SpaceItemGroup = typeof spaceItemGroups[number]
export type SpaceItemRole = Exclude<SpaceItemGroup, 'trashed'>
export const spaceItemPageSize = 50
export const spaceItemQuery = z.object({
  missingOnly: z.literal(true).optional(), spaceId: z.string().uuid(), group: z.enum(spaceItemGroups), offset: z.number().int().nonnegative().default(0)
}).strict()
export type SpaceItemQuery = z.infer<typeof spaceItemQuery>
export interface SpaceItemPage {
  counts: Record<SpaceItemGroup, number>
  items: { id: string; title: string; role: SpaceItemRole; missingPath?: string }[]
  offset: number
  missingIssue?: string
  selectable: number
  // 快捷批选的身份限定在用户看到的这次盘点，与生命周期预览使用同一上限。
  batchIds: string[]
}
