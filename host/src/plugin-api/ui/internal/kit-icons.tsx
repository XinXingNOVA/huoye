import { createContext, createElement, useContext, type SVGProps } from 'react'
import { iconPaths, type IconName } from '../../../shared/icon-catalog'
import type { ThemeIcons } from '../../../shared/theme-icons'

export type { IconName }
export const IconThemeContext = createContext<ThemeIcons | undefined>(undefined)

export function Icon({ name, size = 16, className = '', ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const icon = useContext(IconThemeContext)?.[name]
  return <svg width={size} height={size} viewBox={icon?.viewBox ?? '0 0 24 24'} fill={icon ? 'currentColor' : 'none'} stroke={icon ? 'none' : 'currentColor'} strokeWidth={icon ? 1 : 1.7}
    strokeLinecap={icon ? 'butt' : 'round'} strokeLinejoin={icon ? 'miter' : 'round'} aria-hidden="true" data-hy-icon={name} className={`hy-icon ${className}`} {...props}>
    {icon ? icon.shapes.map(({ tag, attrs }, i) => createElement(tag, { ...attrs, key: i })) : <path d={iconPaths[name]} />}
  </svg>
}
