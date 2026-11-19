import { useMemo } from 'react'
import type {
  ReadonlyPresetValue,
  WorkbenchLayout,
  WorkbenchNode,
  WorkbenchPresetPreview as PreviewData,
  WorkbenchPresetService
} from '../../../plugin-api/ui/workbench-presets'

type Layout = ReadonlyPresetValue<WorkbenchLayout>
type Preview = ReadonlyPresetValue<PreviewData>
function leaves(node: WorkbenchNode): string[] {
  return node.type === 'group' ? [node.id] : [...leaves(node.first), ...leaves(node.second)]
}

function DiagramNode({
  node,
  ids,
  primary,
  layout,
  preview,
  toolTitle
}: {
  node: WorkbenchNode
  ids: string[]
  primary: string
  layout: Layout
  preview?: Preview
  toolTitle(id: string): string
}) {
  if (node.type === 'group') {
    const idx = ids.indexOf(node.id)
    const isPrimary = node.id === primary
    const slot = layout.contents?.[node.id]
    const items = slot?.items ?? []
    const activeIdx = slot?.active ?? 0
    return (
      <div className="preset-diagram-group" data-primary={isPrimary}>
        <div className="preset-diagram-group-head">
          <span className="preset-diagram-group-num">分区 {idx + 1}</span>
          {isPrimary && <span className="preset-diagram-primary-pill">主分区</span>}
        </div>
        <div className="preset-diagram-group-body">
          {items.length ? (
            items.slice(0, 2).map((item, n) => {
              const info = preview?.contents[node.id]?.[n]
              const title = info?.title ?? (item.kind === 'tool' ? toolTitle(item.id) : '功能页面')
              return (
                <div
                  key={n}
                  className={`preset-diagram-surface${n === activeIdx ? ' is-active' : ''}`}
                >
                  <strong className="preset-diagram-surface-title">{title}</strong>
                  {info?.detail && <small className="preset-diagram-surface-detail">{info.detail}</small>}
                </div>
              )
            })
          ) : (
            <span className="preset-diagram-empty muted">保留已有页面</span>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="preset-diagram-split" data-direction={node.direction}>
      <div style={{ flex: `${node.ratio} 1 0%` }}>
        <DiagramNode
          node={node.first}
          ids={ids}
          primary={primary}
          layout={layout}
          preview={preview}
          toolTitle={toolTitle}
        />
      </div>
      <div style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <DiagramNode
          node={node.second}
          ids={ids}
          primary={primary}
          layout={layout}
          preview={preview}
          toolTitle={toolTitle}
        />
      </div>
    </div>
  )
}

function DiagramSidebar({
  side,
  label,
  layout,
  toolTitle
}: {
  side: 'left' | 'right'
  label: string
  layout: Layout
  toolTitle(id: string): string
}) {
  const containers = layout.sidebars?.containers.filter(c => c.side === side && !c.closed) ?? []
  return (
    <div className="preset-diagram-side">
      <span className="preset-diagram-side-title">{label}</span>
      <div className="preset-diagram-side-stack">
        {containers.length ? (
          containers.slice(0, 3).map(c => (
            <span key={c.id} className={`preset-diagram-tool-chip${c.type === 'context' ? ' is-context' : ''}`}>
              {c.type === 'context' ? '智能工具' : toolTitle(c.active || c.views[0] || '')}
            </span>
          ))
        ) : (
          <span className="preset-diagram-tool-chip is-default">默认工具</span>
        )}
      </div>
    </div>
  )
}

/** 纯预览 UI：不打开页面、执行命令或直接访问宿主内部工作区。 */
export function WorkbenchPresetPreview({ layout, service }: { layout: Layout; service: WorkbenchPresetService }) {
  const result = useMemo(() => {
    try {
      return { preview: service.preview(layout) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [layout, service])
  const ids = leaves(layout.root), preview = result.preview
  const toolTitle = (id: string) => preview?.tools.find(t => t.id === id)?.title ?? `未启用工具（${id}）`
  return (
    <div className="workbench-preset-preview">
      <div
        className="preset-diagram"
        role="img"
        aria-label={`${ids.length} 个中央分区，左栏${layout.panels.sidebar ? '展开' : '收起'}，右栏${layout.panels.inspector ? '展开' : '收起'}`}
      >
        {layout.panels.sidebar && <DiagramSidebar side="left" label="左栏" layout={layout} toolTitle={toolTitle} />}
        <DiagramNode
          node={layout.root}
          ids={ids}
          primary={layout.primary}
          layout={layout}
          preview={preview}
          toolTitle={toolTitle}
        />
        {layout.panels.inspector && <DiagramSidebar side="right" label="右栏" layout={layout} toolTitle={toolTitle} />}
      </div>
      <div className="preset-summary-pills">
        <span className="preset-summary-pill">
          中央区域：<strong>{ids.length} 个分区</strong>
        </span>
        <span className="preset-summary-pill">
          左侧栏：<strong>{layout.panels.sidebar ? '展开' : '收起'}</strong>
        </span>
        <span className="preset-summary-pill">
          右侧栏：<strong>{layout.panels.inspector ? '展开' : '收起'}</strong>
        </span>
      </div>
      <details className="preset-region-fold">
        <summary>查看区域与工具配置明细（{ids.length} 个中央分区）</summary>
        <div className="preset-region-details">
        {(['left', 'center', 'right'] as const).map(side => (
          <section key={side}>
            <h4>
              {side === 'center' ? '中央工作区' : side === 'left' ? '左侧栏' : '右侧栏'}
              {side !== 'center' && (
                <span>{layout.panels[side === 'left' ? 'sidebar' : 'inspector'] ? '展开' : '收起'}</span>
              )}
            </h4>
            {side === 'center' ? (
              ids.map((id, i) => (
                <div key={id} className="preset-group-detail">
                  <strong>
                    分区 {i + 1}
                    {id === layout.primary ? ' · 主分区' : ''}
                  </strong>
                  {layout.contents?.[id]?.items.length ? (
                    <ul>
                      {layout.contents[id].items.map((item, n) => (
                        <li key={n}>
                          <span>
                            {preview?.contents[id]?.[n]?.title ??
                              (item.kind === 'tool' ? toolTitle(item.id) : '功能页面')}
                            {layout.contents?.[id]?.active === n && <small>默认显示</small>}
                          </span>
                          {preview?.contents[id]?.[n]?.detail && <small>{preview.contents[id][n].detail}</small>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">保留已有页面；新分区显示开始页</p>
                  )}
                </div>
              ))
            ) : !layout.sidebars ? (
              <p className="muted">沿用当前工具组合</p>
            ) : (
              <>
                {!layout.sidebars.containers.some(c => c.side === side) && (
                  <p className="muted">未指定工具，保留现有固定工具</p>
                )}
                {layout.sidebars.containers
                  .filter(c => c.side === side)
                  .map((c, i) => (
                    <div key={c.id} className="preset-group-detail">
                      <strong>
                        {c.type === 'context' ? '智能工具' : `工具组 ${i + 1}`}
                        {c.closed ? ' · 已关闭' : ''}
                      </strong>
                      {c.type === 'context' ? (
                        <>
                          <p className="muted">跟随当前页面</p>
                          {Object.keys(c.contexts ?? {}).length ? (
                            <ul>
                              {Object.entries(c.contexts ?? {}).map(([type, pref]) => (
                                <li key={type} title={`页面类型：${type}`}>
                                  {pref.tools.length ? pref.tools.map(toolTitle).join('、') : '此类页面不显示工具'}
                                  {pref.active && <small>优先显示：{toolTitle(pref.active)}</small>}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted">使用工具的默认组合</p>
                          )}
                        </>
                      ) : (
                        <ul>
                          {c.views.map(id => (
                            <li key={id} data-hidden={layout.sidebars?.hidden.includes(id)}>
                              <span>
                                {toolTitle(id)}
                                <small>
                                  {layout.sidebars?.hidden.includes(id)
                                    ? '已关闭'
                                    : c.active === id
                                      ? '默认显示'
                                      : ''}
                                </small>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
              </>
            )}
          </section>
        ))}
      </div>
      </details>
      {!!preview?.issues.length && (
        <div className="preset-preview-issues" role="note">
          <strong>预览与可用性提示</strong>
          <ul>
            {preview.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
          <p>应用时会复核并使用可用部分；预览说明失败不影响该内容本身。不会自动安装或启用插件。</p>
        </div>
      )}
      {result.error && (
        <p className="workbench-preset-error" role="alert">
          预览失败：{result.error}
        </p>
      )}
    </div>
  )
}
