import { z } from 'zod'

/** 分组命令的输入；group 是 list_groups 返回的稳定 ID，null 表示“未分组”。 */
export const createGroupSchema = z.object({
  title: z.string().trim().min(1).max(100),
  /** 可选：新建后立即把这个标签放进去（会从原分组移走）。 */
  tag: z.string().trim().min(1).max(200).optional()
}).strict()

export const renameGroupSchema = z.object({
  group: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(100)
}).strict()

export const deleteGroupSchema = z.object({
  group: z.string().min(1).max(200)
}).strict()

export const moveTagSchema = z.object({
  tag: z.string().trim().min(1).max(200),
  group: z.string().min(1).max(200).nullable()
}).strict()
