import type { HTMLAttributes, ReactNode } from 'react'

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
    <div className={`ui-section-header hy-section-header ${className}`.trim()} {...rest}>
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
    <div className={`ui-stat-bar hy-stat-bar ${className}`.trim()} {...rest}>
      <div className="ui-stat-bar-main">
        <strong className="ui-stat-bar-label">{label}</strong>
        {meta && <span className="muted ui-stat-bar-meta">{meta}</span>}
      </div>
      {actions && <div className="ui-stat-bar-actions">{actions}</div>}
    </div>
  )
}
