import { ToolContent } from './ToolContent'
import { ContentDropBoundary } from '../content-drop'
import type { ContextToolInstance } from '../workbench-containers'
import type { UiHost } from '../plugin'
import { sidebarContainerSlot } from './SidebarContainers'
import { RetainedSurface } from './RetainedSurface'

/** 按组＋来源页＋工具持有实例；外壳重挂或跨侧移动只改变插槽，不改变组件身份。 */
export function ContextToolSurfaces({ instances, hostForPage }: { instances: readonly ContextToolInstance[]; hostForPage(id: string): UiHost }) {
  return <>{instances.map(({ key, groupId, source, tool, visible }) => {
    const Content = tool.Component
    return <RetainedSurface key={key} className="context-tool-content" visible={visible} slot={visible ? sidebarContainerSlot('context', groupId) : undefined}>
      <ContentDropBoundary title={tool.title} enabled={visible} query={zone => source.isAvailable() ? tool.dropQuery?.(zone, source) : undefined}>
        <ToolContent id={tool.id} Component={Content} host={hostForPage(source.pageId)} context={source} active={visible}/>
      </ContentDropBoundary>
    </RetainedSurface>
  })}</>
}
