import { ToolContent } from './ToolContent'
import { t, useLanguage, viewTitle } from '../language'
import { ContentDropBoundary } from '../content-drop'
import type { BoundTool } from '../../../shared/sidebar-layout'
import type { PageContext, UiHost } from '../plugin'
import type { ContextTool } from '../context-tools'
import { boundToolUnavailable } from '../context-tools'

export function BoundToolView({ binding, tool, context, active, showSource, sourcePreset, hostForPage, onLocate, onClose }: {
  binding: BoundTool; tool?: ContextTool; context?: PageContext; active: boolean; showSource: boolean; sourcePreset?: string
  hostForPage(id: string): UiHost; onLocate(id: string): void; onClose(): void
}) {
  useLanguage()
  const reason = boundToolUnavailable(binding, tool, context)
  const Component = tool?.Component
  return <div className="bound-tool-view" data-bound-page={binding.pageId}>
    {showSource && <div className="context-tool-source">
      <button disabled={!context} title={t('section.locate')} onClick={() => onLocate(binding.pageId)}>⌖ {viewTitle(sourcePreset, context?.title ?? binding.pageTitle)}</button>
      <button title={t('section.close')} aria-label={t('section.close')} onClick={onClose}>×</button>
    </div>}
    {reason ? <div className="context-tool-empty" role="status">{reason}</div> : Component && context && <ContentDropBoundary title={tool!.title} enabled={active} query={zone => context.isAvailable() ? tool?.dropQuery?.(zone, context) : undefined}><div className="bound-tool-content"><ToolContent id={tool!.id} Component={Component} host={hostForPage(binding.pageId)} context={context} active={active}/></div></ContentDropBoundary>}
  </div>
}
