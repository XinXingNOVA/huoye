import type { ToolViewContribution } from '../plugin-api/ui/contracts'

type ToolInput = Pick<ToolViewContribution, 'id' | 'title' | 'order' | 'placement' | 'context'>
/** 宿主内部的初始组合描述；不是插件可注册的容器类型。 */
interface DefaultToolGroup { id: string; title: string; side: 'left' | 'right'; order: number }
const sideOf = (id: string) => id === 'host.navigation' ? 'left' : id === 'host.inspector' ? 'right' : undefined

/** 识别退役声明只用于报错；不转换或执行旧接口。 */
export function rejectLegacyToolDeclarations(plugin: object) {
  for (const key of ['sidePanels', 'viewContainers', 'windowWidgets']) {
    if (key in plugin) throw new Error(`界面接口 ${key} 已退役，请升级插件，使用 toolViews + tool-placement-v1`)
  }
}
export function checkToolFeatures(tools: readonly ToolInput[], features: readonly string[] = []) {
  for (const feature of ['view-containers-v1', 'tool-docking-v1']) {
    if (features.includes(feature)) throw new Error(`界面能力 ${feature} 已退役，请升级插件到 tool-placement-v1`)
  }
  if (tools.length && !features.includes('tool-placement-v1')) throw new Error('独立工具放置声明需要 tool-placement-v1 界面能力')
}

/** 校验与初始装配共用；生成默认分组不会写入、移动或重新打开用户已有布局。 */
export function resolveToolDeclarations<T extends ToolInput>(pluginId: string, tools: readonly T[]) {
  const groups = new Map<string, DefaultToolGroup>()
  const views = tools.map(tool => {
    const placement = tool.placement
    if ('container' in tool || (placement && typeof placement === 'object' && 'container' in placement)) throw new Error(`工具 ${tool.id} 的 container 声明已退役，请改用 placement.default`)
    if (placement !== undefined && (!placement || typeof placement !== 'object' || Array.isArray(placement) ||
        !Array.isArray(placement.regions) || !placement.regions.length || placement.regions.some(r => !['left', 'center', 'right'].includes(r)) || new Set(placement.regions).size !== placement.regions.length)) throw new Error(`工具停靠声明无效：${tool.id}`)
    const regions = [...(placement?.regions ?? ['left', 'right'] as const)]
    let groupId: string, side: 'left' | 'right' | undefined
    if (tool.context) {
      if (placement?.default !== undefined) throw new Error(`智能工具由上下文决定初始容器，不填写默认位置：${tool.id}`)
      groupId = 'host.context'
    } else {
      const suggestion = placement?.default
      if (suggestion !== undefined && (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion) || !['left', 'right'].includes(suggestion.region))) throw new Error(`工具默认区域无效：${tool.id}`)
      side = suggestion?.region ?? (regions.includes('right') ? 'right' : regions.includes('left') ? 'left' : undefined)
      if (!side || !regions.includes(side)) throw new Error(`普通工具需要允许一个默认侧栏区域：${tool.id}`)
      const requested = suggestion?.group
      if (requested !== undefined && (typeof requested !== 'string' || !requested || requested.length > 150 ||
          (!sideOf(requested) && (!requested.startsWith(pluginId + '.') || requested.length <= pluginId.length + 1 || /\s/.test(requested))))) throw new Error(`默认组合必须使用本插件的组 ID 或宿主导航／详情组：${tool.id}`)
      groupId = requested ?? `default:${tool.id}`
      const groupSide = sideOf(groupId) ?? groups.get(groupId)?.side
      if (groupSide && groupSide !== side) throw new Error(`同一默认组合的区域声明不一致：${groupId}`)
      if (!groupSide) groups.set(groupId, { id: groupId, side, title: tool.title, order: tool.order })
    }
    // 默认归属属于宿主装配信息，插件内容不依赖容器。
    return { ...tool, container: tool.context ? 'host.context' : groupId, placement: { regions } }
  })
  return { groups: [...groups.values()], views }
}
