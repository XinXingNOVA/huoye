import type { HTMLAttributes, ReactNode } from 'react'

/**
 * 统一界面原语（Design Primitives）：
 * 1. SectionHeader：模块页头（左标题+精简副标题 / 右操作区）
 * 2. SettingGroup：Obsidian 风格圆角设置分组容器
 * 3. SettingRow：Obsidian 风格「左标题+简短说明 / 右侧控件」单行配置项
 * 4. StatBar：紧凑状态指标与快捷操作条
 */

export function SectionHeader({
  title,
  subtitle,
  badge,
  actions,
  className = '',
  ...rest
}: {
  title: ReactNode
  subtitle?: ReactNode
  badge?: ReactNode
  actions?: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={`ui-section-header ${className}`.trim()} {...rest}>
      <div className="ui-section-header-main">
        <div className="ui-section-header-title-row">
          <h2>{title}</h2>
          {badge && <span className="ui-section-badge">{badge}</span>}
        </div>
        {subtitle && <p className="muted ui-section-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ui-section-actions">{actions}</div>}
    </div>
  )
}

export { SettingGroup, SettingRow } from '../../../plugin-api/ui/widgets'

export function StatBar({
  label,
  meta,
  actions,
  className = '',
  ...rest
}: {
  label: ReactNode
  meta?: ReactNode
  actions?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`ui-stat-bar ${className}`.trim()} {...rest}>
      <div className="ui-stat-bar-main">
        <strong className="ui-stat-bar-label">{label}</strong>
        {meta && <span className="muted ui-stat-bar-meta">{meta}</span>}
      </div>
      {actions && <div className="ui-stat-bar-actions">{actions}</div>}
    </div>
  )
}
