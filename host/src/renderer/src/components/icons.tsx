import type { QuickActionIcon } from '../../../plugin-api/ui/commands'
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function VaultIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 9V7m0 10v-2m-3-3H7m10 0h-2" />
    </Svg>
  )
}

export function SearchCommandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h10M18 7h2M4 17h4m4 0h8" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </Svg>
  )
}

export function LayoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </Svg>
  )
}

export function SparklesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4Z" />
      <path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  )
}

export function FolderSpaceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M8 13h8" />
    </Svg>
  )
}

/** 根据侧栏容器或工具视图 ID 提供统一线性图标 */
export function SidebarViewIcon({ id, size = 18 }: { id: string; size?: number }) {
  if (id === 'host.filters') return <Svg size={size}><path d="M4 5h16M7 12h10m-7 7h4"/></Svg>
  if (id === 'host.navigation' || id.includes('nav')) {
    return (
      <Svg size={size}>
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </Svg>
    )
  }
  if (id === 'host.inspector' || id.includes('inspector')) {
    return (
      <Svg size={size}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16M7 9h5m-5 4h5m-5 4h3" />
      </Svg>
    )
  }
  if (id.includes('ai-chat') || id.includes('ai')) {
    return <SparklesIcon size={size} />
  }
  if (id.includes('music') || id.includes('audio')) {
    return (
      <Svg size={size}>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </Svg>
    )
  }
  if (id.includes('pomodoro') || id.includes('timer')) {
    return (
      <Svg size={size}>
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2.5 2.5M9 2h6" />
      </Svg>
    )
  }
  if (id.includes('daily') || id.includes('calendar') || id.includes('note')) {
    return (
      <Svg size={size}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </Svg>
    )
  }
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </Svg>
  )
}

/** 根据中央标签页类型提供语义化小图标 */
export function TabTypeIcon({ type, params }: { type: string; params?: Record<string, unknown> }) {
  if (type === 'collection') {
    const preset = typeof params?.presetId === 'string' ? params.presetId : ''
    const scope = (params?.query as { scope?: string } | undefined)?.scope
    if (scope === 'trash' || preset === 'trash') {
      return (
        <Svg size={14} className="tab-type-icon">
          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </Svg>
      )
    }
    if (preset === 'unorganized') {
      return (
        <Svg size={14} className="tab-type-icon">
          <path d="M22 12h-6l-2 3h-4l-2-3H2" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
        </Svg>
      )
    }
    return (
      <Svg size={14} className="tab-type-icon">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
      </Svg>
    )
  }
  if (type === 'file-spaces') {
    return <FolderSpaceIcon size={14} className="tab-type-icon" />
  }
  if (type === 'history') {
    return (
      <Svg size={14} className="tab-type-icon">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5m4-1v5l3 2" />
      </Svg>
    )
  }
  if (type === 'workspace.start') {
    return <SparklesIcon size={14} className="tab-type-icon" />
  }
  if (type === 'settings') {
    return <SettingsIcon size={14} className="tab-type-icon" />
  }
  if (type === 'data.details' || type === 'management') {
    return (
      <Svg size={14} className="tab-type-icon">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
      </Svg>
    )
  }
  if (type.includes('pdf') || type.includes('epub') || type.includes('text') || type.includes('note')) {
    return (
      <Svg size={14} className="tab-type-icon">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h5" />
      </Svg>
    )
  }
  return (
    <Svg size={14} className="tab-type-icon">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16" />
    </Svg>
  )
}

/** 设置导航分类图标（保持纯 SVG 无内部文本，不影响 button.textContent） */
export function SettingSectionIcon({ id, isPlugin }: { id: string; isPlugin?: boolean }) {
  if (id === 'import' || id === 'spaces') {
    return <FolderSpaceIcon size={15} />
  }
  if (id === 'plugins' || id === 'packages') {
    return (
      <Svg size={15}>
        <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83" />
      </Svg>
    )
  }
  if (id === 'plugin-presets') {
    return <LayoutIcon size={15} />
  }
  if (id === 'development') {
    return (
      <Svg size={15}>
        <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
      </Svg>
    )
  }
  if (id === 'maintenance') {
    return (
      <Svg size={15}>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
        <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      </Svg>
    )
  }
  if (id === 'appearance') {
    return (
      <Svg size={15}>
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.96-4.03-9-9-9Z" />
      </Svg>
    )
  }
  if (id === 'editors') {
    return (
      <Svg size={15}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </Svg>
    )
  }
  if (isPlugin || id.includes('.')) {
    return <SparklesIcon size={15} />
  }
  return <SettingsIcon size={15} />
}

export function EditPencilIcon(props: IconProps) {
  return (
    <Svg size={13} {...props}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </Svg>
  )
}

/** 侧栏预设视图图标（纯 SVG 无文本，不改变 button.textContent） */
export function PresetViewIcon({ id }: { id: string }) {
  if (id === 'all') {
    return (
      <Svg size={14} className="nav-item-icon">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </Svg>
    )
  }
  if (id === 'trash') {
    return (
      <Svg size={14} className="nav-item-icon">
        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      </Svg>
    )
  }
  if (id === 'management') {
    return (
      <Svg size={14} className="nav-item-icon">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
        <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      </Svg>
    )
  }
  if (id.includes('image')) {
    return (
      <Svg size={14} className="nav-item-icon">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </Svg>
    )
  }
  if (id.includes('video')) {
    return (
      <Svg size={14} className="nav-item-icon">
        <rect x="2" y="4" width="20" height="16" rx="2.5" />
        <path d="m10 9 5 3-5 3Z" />
      </Svg>
    )
  }
  if (id.includes('audio')) {
    return (
      <Svg size={14} className="nav-item-icon">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </Svg>
    )
  }
  if (id.includes('pdf') || id.includes('doc')) {
    return (
      <Svg size={14} className="nav-item-icon">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h5" />
      </Svg>
    )
  }
  if (id.includes('text') || id.includes('note')) {
    return (
      <Svg size={14} className="nav-item-icon">
        <path d="M17 6.1H3M21 12.1H3M15.1 18H3" />
      </Svg>
    )
  }
  if (id.includes('anchor') || id.includes('annotation') || id.includes('clip')) {
    return (
      <Svg size={14} className="nav-item-icon">
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z" />
      </Svg>
    )
  }
  if (id.includes('edit')) {
    return <EditPencilIcon size={14} className="nav-item-icon" />
  }
  return (
    <Svg size={14} className="nav-item-icon">
      <circle cx="12" cy="12" r="4" />
    </Svg>
  )
}



/** 固定操作与插件快捷入口共享的宿主图标集。 */
export function QuickActionIconView({ name = 'tool' }: { name?: QuickActionIcon }) {
  const paths: Record<QuickActionIcon, string> = {
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    text: 'M5 3h10l4 4v14H5z M15 3v5h4 M8 12h8 M8 16h5',
    import: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
    command: 'M5 5l6 7-6 7 M13 19h6',
    tool: 'M14 4a6 6 0 0 0-7 7L3 17a3 3 0 0 0 4 4l6-5a6 6 0 0 0 7-8l-4 4-4-4z',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
    book: 'M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1z M12 5v15',
    tag: 'M3 3h8l10 10-8 8L3 11z M7 7h.01',
    music: 'M9 18V5l11-2v13 M9 8l11-2 M9 18a3 3 0 1 1-3-3h3 M20 16a3 3 0 1 1-3-3h3',
    chat: 'M21 4H3v14h5l4 4 4-4h5z M7 9h10 M7 13h7',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
    layout: 'M3 4h18v16H3z M9 4v16 M9 12h12',
    folder: 'M3 6h7l2 3h9v11H3z',
    plus: 'M12 5v14 M5 12h14',
    split: 'M3 4h18v16H3z M12 4v16',
    history: 'M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l4 2'
  }
  return <Svg size={18}><path d={paths[name]}/></Svg>
}

export function GripIcon(props: IconProps) {
  return <Svg {...props}>{[6, 12, 18].flatMap(y => [9, 15].map(x => <circle key={`${x}:${y}`} cx={x} cy={y} r="1"/>))}</Svg>
}
export function LinkIcon(props: IconProps) {
  return <Svg {...props}><path d="M9 7H7a5 5 0 0 0 0 10h2m6-10h2a5 5 0 0 1 0 10h-2M8 12h8"/></Svg>
}
