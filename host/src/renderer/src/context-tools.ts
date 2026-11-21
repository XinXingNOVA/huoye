import { uiText } from '../../shared/i18n/interface-display'
import type { PageContext } from '../../plugin-api/ui/page-context'
import type { BoundTool, ContextToolPreferences, SidebarLayout } from '../../shared/sidebar-layout'
import { chooseContentInstance, sameInstanceContent, type ContentInstance } from './content-instances'
import type { ToolViewContribution } from '../../plugin-api/ui/contracts'
export type ContextTool = ToolViewContribution & { context: NonNullable<ToolViewContribution['context']> }

export function contextToolsFor(tools: ContextTool[], context: PageContext | undefined, preference?: ContextToolPreferences) {
  const candidates = context ? tools.filter(t => t.context.requires.every(key => context.capabilities[key] != null)) : []
  const order = preference?.tools ?? candidates.filter(t => t.context.defaultVisible !== false).map(t => t.id)
  const visible = order.flatMap(id => candidates.find(t => t.id === id) ?? [])
  const active = visible.find(t => t.id === preference?.active)?.id ?? visible[0]?.id
  return { candidates, order, visible, active }
}

export function boundToolUnavailable(binding: BoundTool, tool: ContextTool | undefined, context: PageContext | undefined): string | undefined {
  if (!tool) return uiText("工具插件暂不可用")
  if (!tool.context.detachable) return uiText("此工具暂不支持独立放置")
  if (!context) return uiText("目标页面已关闭")
  if (context.type !== binding.pageType) return uiText("目标页面类型已改变")
  if (!context.isAvailable()) return uiText("目标页面暂不可用")
  if (!tool.context.requires.every(k => context.capabilities[k] != null)) return uiText("目标页面不再提供此工具需要的能力")
}
type BindingIdentity = Pick<BoundTool, 'toolId' | 'pageId' | 'pageType'>
function boundInstance(id: string, binding: BindingIdentity): ContentInstance {
  return { id, typeId: binding.toolId, contentKey: JSON.stringify([binding.pageType, binding.pageId]) }
}
function boundInstances(layout: SidebarLayout): ContentInstance[] {
  // bindings 是权威记录；中央工具标签只是位置，不重复计数。失效／隐藏的绑定仍占名额。
  return Object.entries(layout.bindings ?? {}).map(([id, binding]) => boundInstance(id, binding))
}
export function findBoundTool(layout: SidebarLayout, binding: BindingIdentity): string | undefined {
  const candidate = boundInstance('', binding)
  return boundInstances(layout).find(item => sameInstanceContent(item, candidate))?.id
}

/** 固定工具声明适配到公共实例决策；智能组中的运行时投影不参与独立实例计数。 */
export function chooseBoundTool(layout: SidebarLayout, tool: ContextTool | undefined, context: PageContext | undefined): { existing?: string; blocked?: string } {
  if (!tool?.context.detachable) return { blocked: uiText("此工具未声明支持独立放置") }
  if (!context?.isAvailable() || !tool.context.requires.every(k => context.capabilities[k] != null)) return { blocked: uiText("来源页面已关闭或不再适用") }
  const instances = boundInstances(layout), max = tool.context.detachable.maxInstances
  const decision = chooseContentInstance(instances, boundInstance('', { toolId: tool.id, pageId: context.pageId, pageType: context.type }), {
    reuse: 'content', allowNew: false, limit: { scope: 'type', max }
  })
  if (decision.action === 'reuse') return { existing: decision.id }
  if (decision.action === 'reject') return { blocked: uiText("此工具最多独立放置 {max} 份，请先关闭一份", { max }) }
  // 工作区的结构保护上限，不是插件业务配额；仅限制新增，不阻止复用／移动。
  if (instances.length >= 128) return { blocked: uiText("固定工具数量已达上限") }
  return {}
}
