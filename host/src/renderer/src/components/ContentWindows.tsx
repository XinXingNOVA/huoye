import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { AuxiliarySurface } from '../auxiliary-surface'
import { editorsOf } from '../editor-layout'
import type { WorkspaceController } from '../app/workspace'
import type { UiHost } from '../plugin'
import type { ComponentProps } from 'react'
import { EditorWorkspace } from './EditorWorkspace'
/** 原有普通容器的另一显示位置；不另建页面、上下文、草稿或插件运行时。 */
export function ContentWindows({ workspace: controller, host, drop }: { workspace: WorkspaceController; host: UiHost; drop?: ComponentProps<typeof EditorWorkspace>['drop'] }) {
  useUiLocale()
  const w = controller.snapshot!
  return <>{editorsOf(w).groups.filter(g => g.window).map(group => {
    const entry = w.tabs.find(t => t.id === group.active)
    const title = String(entry?.params.title ?? entry?.params.name ?? uiText("活页Huoye"))
    return <AuxiliarySurface key={group.id} kind={`content:${group.id}`} title={title} bounds={group.window} focusOnMount={group.tabs.includes(w.active)}
      onFocus={() => controller.activate(group.active)} onBounds={bounds => controller.editorActions.onWindowBounds(group.id, bounds)}
      onClose={() => controller.closeContentWindow(group.id)} onLost={() => controller.editorActions.onReturn(group.id)}>
      <div className="content-window" inert={controller.lifecycle.leaving}>
        <EditorWorkspace workspace={w} host={host} catalog={controller.catalog} docking={controller.docking} groupId={group.id} drop={drop} {...controller.editorActions}/>
      </div>
    </AuxiliarySurface>
  })}</>
}
