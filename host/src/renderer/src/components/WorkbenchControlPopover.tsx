import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { useRef, useSyncExternalStore } from 'react'
import type { UiHost } from '../../../plugin-api/ui/contracts'
import type { WorkbenchNode } from '../../../plugin-api/ui/workbench-presets'
import type { SidebarSnapshot } from '../workbench-containers'
import type { ContainerActions } from '../app/container-actions'
import { PresetMiniGlyph } from './PresetMiniGlyph'
import { useModalFocus } from './modal-focus'
import './workbench-presets.css'

const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const groups = (node: WorkbenchNode): number => node.type === 'group' ? 1 : groups(node.first) + groups(node.second)

/** 左下角「工作台与布局」可视化控制中心浮层（替代原生二级右键菜单）。 */
export function WorkbenchControlPopover({
  host,
  snapshot: sideSnap,
  actions,
  onRevealTool,
  onClose
}: {
  host: UiHost
  snapshot: SidebarSnapshot
  actions: ContainerActions
  onRevealTool(id: string): void
  onClose(): void
}) {
  const service = host.workbenchPresets
  const presetSnap = useSyncExternalStore(service.subscribe, service.getSnapshot)
  const ref = useRef<HTMLDivElement>(null)

  useModalFocus(ref)

  useUiEffect(display => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (ref.current?.contains(target) || target.closest('[aria-label="工作台布局"]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    display.onWindow('mousedown', onDown, true)
    display.onWindow('keydown', onKey, true)
  }, [onClose])

  const builtins = presetSnap.presets.filter(p => p.source.kind === 'builtin')
  const extras = presetSnap.presets.filter(p => p.source.kind !== 'builtin')
  const cur = presetSnap.current
  const curGroups = cur ? groups(cur.root) : 1
  const leftOpen = sideSnap.regions.left.visible
  const rightOpen = sideSnap.regions.right.visible

  const isModeActive = (id: string) => {
    if (id === 'host.organize') return curGroups === 1 && leftOpen && rightOpen
    if (id === 'host.focus') return curGroups === 1 && !leftOpen && !rightOpen
    if (id === 'host.compare') return curGroups === 2 && !leftOpen && !rightOpen
    return false
  }

  const runSafe = (fn: () => void) => {
    try {
      fn()
    } catch (e) {
      host.notify(reason(e))
    }
  }

  return (
    <div
      ref={ref}
      className="workbench-control-popover"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label="工作台与布局控制面板"
      onKeyDown={e => e.stopPropagation()}
    >
      <div className="wb-pop-section">
        <div className="wb-pop-head">
          <span>常用窗口形态</span>
          {presetSnap.canReturn && (
            <button
              type="button"
              className="wb-pop-link"
              onClick={() => runSafe(() => service.back())}
            >
              ↩ 返回切换前
            </button>
          )}
        </div>
        <div className="wb-pop-modes">
          {builtins.map(b => {
            const active = isModeActive(b.id)
            return (
              <button
                key={b.id}
                type="button"
                className={`wb-pop-mode-card${active ? ' is-active' : ''}`}
                onClick={() => runSafe(() => service.apply(b.id))}
              >
                <PresetMiniGlyph layout={b.layout} size="md" />
                <strong>{b.title}</strong>
                <small>
                  {b.id === 'host.organize'
                    ? '三栏展开'
                    : b.id === 'host.focus'
                      ? '收起侧栏'
                      : '双栏分屏'}
                </small>
              </button>
            )
          })}
        </div>
      </div>

      <div className="wb-pop-section">
        <div className="wb-pop-head">
          <span>侧栏与工具面板</span>
          <button
            type="button"
            className="wb-pop-link"
            onClick={() => actions.resetSidebars()}
            title="恢复默认侧栏工具与位置"
          >
            恢复默认侧栏
          </button>
        </div>
        <div className="wb-pop-sidebars">
          <button
            type="button"
            className={`wb-pop-side-toggle${leftOpen ? ' is-on' : ''}`}
            aria-pressed={leftOpen}
            onClick={() => actions.setVisible('left', !leftOpen)}
          >
            <span>◧ 左侧栏</span>
            <small>{leftOpen ? '已展开' : '已收起'}</small>
          </button>
          <button
            type="button"
            className={`wb-pop-side-toggle${rightOpen ? ' is-on' : ''}`}
            aria-pressed={rightOpen}
            onClick={() => actions.setVisible('right', !rightOpen)}
          >
            <span>◨ 右侧栏</span>
            <small>{rightOpen ? '已展开' : '已收起'}</small>
          </button>
        </div>
        <div className="wb-pop-tools">
          {sideSnap.tools.map(tool => {
            const group = sideSnap.groups.find(g => g.items.some(i => i.id === tool.id))
            const inCenter = !!tool.pageId
            const isOpen = !!group || inCenter
            const isVisible = (group && group.visible && group.active === tool.id) || inCenter
            const sideBadge = group ? (group.side === 'left' ? '左' : '右') : inCenter ? '中' : ''
            return (
              <button
                key={tool.id}
                type="button"
                className={`wb-pop-tool-chip${isOpen ? ' is-open' : ''}${isVisible ? ' is-visible' : ''}`}
                title={isVisible && !inCenter ? `点击关闭「${tool.title}」` : `点击显示「${tool.title}」`}
                onClick={() => {
                  if (isVisible && !inCenter) actions.closeTool(tool.id)
                  else onRevealTool(tool.id)
                }}
              >
                <span className="wb-pop-tool-mark">{isOpen ? '✓' : '+'}</span>
                <span className="wb-pop-tool-name">{tool.label}</span>
                {sideBadge && <small className="wb-pop-tool-side">{sideBadge}</small>}
              </button>
            )
          })}
          {!sideSnap.groups.some(g => g.type === 'context' && g.present) && (
            <button
              type="button"
              className="wb-pop-tool-chip"
              title="在右侧栏新增跟随当前页面的智能工具组"
              onClick={() => actions.addContext('right')}
            >
              <span className="wb-pop-tool-mark">+</span>
              <span className="wb-pop-tool-name">智能工具组</span>
            </button>
          )}
        </div>
      </div>

      {extras.length > 0 && (
        <div className="wb-pop-section">
          <div className="wb-pop-head">
            <span>方案与自定义预设</span>
            <button
              type="button"
              className="wb-pop-link"
              onClick={() => {
                onClose()
                host.openWorkbenchPresets('manage')
              }}
            >
              全部 ({presetSnap.presets.length}) →
            </button>
          </div>
          <div className="wb-pop-preset-list">
            {extras.slice(0, 5).map(p => (
              <button
                key={p.id}
                type="button"
                className="wb-pop-preset-row"
                onClick={() => {
                  runSafe(() => service.apply(p.id))
                  onClose()
                }}
              >
                <div className="wb-pop-preset-main">
                  <PresetMiniGlyph layout={p.layout} size="sm" />
                  <span className="wb-pop-preset-title">{p.title}</span>
                </div>
                <small className="wb-pop-preset-meta">
                  {'title' in p.source ? p.source.title : `${groups(p.layout.root)} 分区`}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="wb-pop-footer">
        <button
          type="button"
          className="small"
          onClick={() => {
            onClose()
            host.openWorkbenchPresets('save')
          }}
        >
          + 保存当前布局…
        </button>
        <button
          type="button"
          className="small primary"
          onClick={() => {
            onClose()
            host.openWorkbenchPresets('manage')
          }}
        >
          管理布局预设…
        </button>
      </div>
    </div>
  )
}

