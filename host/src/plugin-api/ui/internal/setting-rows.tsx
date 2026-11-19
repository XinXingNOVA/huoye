import type { HTMLAttributes, ReactNode } from 'react'

export function SettingGroup({
  title,
  description,
  action,
  children,
  className = '',
  ...rest
}: {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={`ui-setting-group ${className}`.trim()} {...rest}>
      {(title || action) && (
        <div className="ui-setting-group-head">
          {title && <h3 className="ui-setting-group-title">{title}</h3>}
          {action && <div className="ui-setting-group-action">{action}</div>}
        </div>
      )}
      {description && <p className="ui-setting-desc muted">{description}</p>}
      <div className="ui-setting-group-card">{children}</div>
    </div>
  )
}

export function SettingRow({
  title,
  description,
  children,
  vertical = false,
  className = '',
  ...rest
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  vertical?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      className={`ui-setting-row${vertical ? ' is-vertical' : ''} ${className}`.trim()}
      {...rest}
    >
      <div className="ui-setting-info">
        <div className="ui-setting-title">{title}</div>
        {description && <div className="ui-setting-desc muted">{description}</div>}
      </div>
      {children && <div className="ui-setting-control">{children}</div>}
    </div>
  )
}
