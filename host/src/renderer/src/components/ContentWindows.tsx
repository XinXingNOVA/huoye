import { uiText, useUiLocale } from '../../../shared/i18n/interface-display'
import { Button, IconButton } from '../../../plugin-api/ui/kit'
import { AuxiliarySurface } from '../auxiliary-surface'
import { editorsOf } from '../editor-layout'
import type { WorkspaceController } from '../app/workspace'
import type { UiHost } from '../plugin'
import { useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { EditorWorkspace } from './EditorWorkspace'
/** Electron 的原生拖动区会接管鼠标命中，不能用该区域的 CSS :hover 维持展开。 */
function MiniChrome({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useUiEffect(display => {
    if (!open) return
    display.onWindow('pointermove', event => {
      const rect = box.current?.getBoundingClientRect()
      if (rect && (event.clientX < rect.left || event.clientX > rect.right || event.clientY > rect.bottom)) setOpen(false)
    })
    display.onWindow('blur', () => setOpen(false))
  }, [open])
  return <div className="content-mini-chrome" ref={box} data-open={open || undefined}
    onPointerEnter={() => setOpen(true)} onPointerMove={() => setOpen(true)}>{children}</div>
}

/** 原有普通容器的另一显示位置；不另建页面、上下文、草稿或插件运行时。 */
export function ContentWindows({ workspace: controller, host, drop }: { workspace: WorkspaceController; host: UiHost; drop?: ComponentProps<typeof EditorWorkspace>['drop'] }) {
  useUiLocale()
  const w = controller.snapshot!
  return <>{editorsOf(w).groups.filter(g => g.window).map(group => {
    const entry = w.tabs.find(t => t.id === group.active)
    const title = String(entry?.params.title ?? entry?.params.name ?? uiText("活页Huoye"))
    const kind = `content:${group.id}` as const
    const toggle = (mode: 'pinned' | 'minimal') => void window.bridge.auxiliary.toggleMode(kind, mode).catch(error => host.notify(String(error)))
    return <AuxiliarySurface key={group.id} kind={kind} title={title} bounds={group.window} focusOnMount={group.tabs.includes(w.active)}
      onFocus={() => controller.select(group.active)} onBounds={bounds => controller.editorActions.onWindowBounds(group.id, bounds)}
      onClose={() => controller.closeContentWindow(group.id)} onLost={() => controller.editorActions.onReturn(group.id)}>
      <div className="content-window" data-minimal={group.window?.minimal} inert={controller.lifecycle.leaving}>
        {group.window?.minimal && <MiniChrome>
          <div className="content-mini-controls">
            <span className="window-drag-space" title={uiText("拖动窗口")}>⠿</span>
            <Button size="sm" aria-label={uiText("置顶")} title={uiText("置顶")} aria-pressed={!!group.window.pinned} onClick={() => toggle('pinned')}><span className="mini-caption">{uiText("置顶")}</span><span className="mini-symbol" aria-hidden="true">⚲</span></Button>
            <Button size="sm" aria-label={uiText("退出精简")} title={uiText("退出精简")} onClick={() => toggle('minimal')}><span className="mini-caption">{uiText("退出精简")}</span><span className="mini-symbol" aria-hidden="true">⛶</span></Button>
            <IconButton size="sm" icon="close" label={uiText("关闭窗口")} onClick={() => void controller.closeContentWindow(group.id)}/>
          </div>
        </MiniChrome>}
        <EditorWorkspace workspace={w} host={host} catalog={controller.catalog} docking={controller.docking} groupId={group.id} drop={drop} {...controller.editorActions}/>
      </div>
    </AuxiliarySurface>
  })}</>
}
