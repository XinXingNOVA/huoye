import { z } from 'zod'

/**
 * 写笔记的输入。expectedSeq 是可选的乐观锁：
 * - 省略：不校验，直接写（调用方已经确认过内容）；
 * - 数字：必须与该素材当前笔记块的 seq 一致；
 * - null：要求写之前这里还没有笔记。
 */
export const setNoteSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().max(32000),
  expectedSeq: z.union([z.number().int().min(0), z.null()]).optional()
}).strict()
