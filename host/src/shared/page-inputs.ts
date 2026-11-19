import { z } from 'zod'

export const pageInputsSchema = z.object({ receive: z.boolean().optional(), create: z.boolean().optional(), reason: z.string().trim().min(1).max(500).optional() }).strict()
export type PageInputs = z.infer<typeof pageInputsSchema>
/** 窗口路由规则，不是数据权限；未声明保持既有页面行为。 */
export function pageInputReason(inputs: PageInputs | undefined, action: 'receive' | 'create'): string | undefined {
  if (inputs?.[action] !== false) return
  return inputs.reason ?? (action === 'receive' ? '此页面不接收拖入、粘贴或导入，请到其他视图收录' : '此页面不支持新建素材，请到其他视图新建')
}
