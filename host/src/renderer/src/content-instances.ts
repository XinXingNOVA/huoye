/** 当前仓库窗口的逻辑实例；不包含位置、可见性或 React 挂载状态。 */
export interface ContentInstance {
  id: string
  typeId: string
  contentKey?: string
}
export interface ContentInstanceRule {
  reuse: 'content' | 'type' | 'none'
  /** 只约束显式新建；普通打开没有可复用实例时仍可创建第一份。 */
  allowNew: boolean
  limit?: { scope: 'content' | 'type'; max: number }
}
export interface InstanceRequest {
  newView?: boolean
  preferred?: readonly string[]
  /** 替换或导航中的旧实例不重复占用名额。 */
  omit?: string
}
export type InstanceDecision =
  | { action: 'create' }
  | { action: 'reuse'; id: string }
  | { action: 'reject'; reason: 'new-not-allowed' | 'limit' }

export function sameInstanceContent(a: ContentInstance, b: ContentInstance): boolean {
  return a.typeId === b.typeId && a.contentKey !== undefined && a.contentKey === b.contentKey
}

/** 只读决策。调用方提供完整逻辑记录（含隐藏、暂未挂载实例），适配身份并校验声明。
 * 复用优先于数量限制，收紧规则不阻止定位已有实例；不在这里移动、保存或清理存档。
 */
export function chooseContentInstance(instances: readonly ContentInstance[], entry: ContentInstance, rule: ContentInstanceRule, request: InstanceRequest = {}): InstanceDecision {
  const candidates = instances.filter(item => item.id !== request.omit && item.typeId === entry.typeId)
  const matching = candidates.filter(item => sameInstanceContent(entry, item))
  if (!request.newView && rule.reuse !== 'none') {
    const reusable = rule.reuse === 'type' ? candidates : matching
    if (reusable.length) return { action: 'reuse', id: request.preferred?.find(id => reusable.some(item => item.id === id)) ?? reusable[0].id }
  }
  if (request.newView && !rule.allowNew) return { action: 'reject', reason: 'new-not-allowed' }
  const limit = rule.limit
  if (limit && (limit.scope === 'type' ? candidates : matching).length >= limit.max) return { action: 'reject', reason: 'limit' }
  return { action: 'create' }
}
