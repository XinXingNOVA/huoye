import { acceleratorLabel } from '../widgets'

export function PanelToggle({ side, expanded, onToggle }: { side: 'left' | 'right'; expanded: boolean; onToggle(): void }) {
  const left = side === 'left'
  const label = `${expanded ? '收起' : '展开'}${left ? '左侧栏' : '右侧栏'}`
  return (
    <button
      type="button"
      className="panel-toggle"
      title={`${label}（${acceleratorLabel(left ? 'CmdOrCtrl+\\' : 'Shift+CmdOrCtrl+\\')}）`}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={`${left ? 'sidebar' : 'inspector'}-panel`}
      onClick={onToggle}
      onKeyDown={(e) => {
        // 空格、回车用于激活按钮，不交给标签页的预览与改名快捷键。
        if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d={left ? 'M9 4v16' : 'M15 4v16'} />
        <rect className="panel-toggle-fill" x={left ? 4.5 : 16.5} y="5.5" width="3" height="13" rx="0.5" fill="currentColor" stroke="none" />
      </svg>
    </button>
  )
}
