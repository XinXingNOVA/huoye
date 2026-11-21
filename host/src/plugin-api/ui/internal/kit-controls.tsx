import type { ComponentProps, KeyboardEvent } from 'react'
import { isEnter } from '../widgets'
import { Icon, type IconName } from './kit-icons'

export type ButtonProps = ComponentProps<'button'> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

export function Button({ variant = 'default', size = 'md', loading, disabled, className = '', type = 'button', children, ...props }: ButtonProps) {
  return <button {...props} type={type} className={`hy-button ${className}`} data-variant={variant} data-size={size}
    aria-busy={loading || undefined} disabled={disabled || loading}>{loading && <span aria-hidden="true" className="hy-spinner"/>}{children}</button>
}

export function IconButton({ icon, label, className = '', ...props }: Omit<ButtonProps, 'children'> & { icon: IconName; label: string }) {
  return <Button variant="ghost" title={label} {...props} className={`hy-icon-button ${className}`} aria-label={label}><Icon name={icon}/></Button>
}

function inputKey<T extends HTMLElement>(e: KeyboardEvent<T>, onKeyDown?: (e: KeyboardEvent<T>) => void, onEnter?: (e: KeyboardEvent<T>) => void) {
  // Candidate confirmation belongs to the IME. Keep parent form/shortcut handlers out of it.
  if (e.key === 'Enter' && !isEnter(e)) { e.preventDefault(); e.stopPropagation(); return }
  onKeyDown?.(e)
  if (onEnter && !e.defaultPrevented && isEnter(e)) { e.preventDefault(); onEnter(e) }
}
export function Input({ className = '', onKeyDown, onEnter, ...props }: ComponentProps<'input'> & { onEnter?: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  return <input {...props} className={`hy-input ${className}`} onKeyDown={e => inputKey(e, onKeyDown, onEnter)}/>
}
export function TextArea({ className = '', onKeyDown, onEnter, ...props }: ComponentProps<'textarea'> & { onEnter?: (e: KeyboardEvent<HTMLTextAreaElement>) => void }) {
  return <textarea {...props} className={`hy-textarea ${className}`} onKeyDown={e => inputKey(e, onKeyDown, onEnter)}/>
}
/** A themed single-choice native select, including the Chromium picker in the owning window. */
export function Select({ className = '', ...props }: Omit<ComponentProps<'select'>, 'multiple' | 'size'>) {
  return <select {...props} className={`hy-select ${className}`}/>
}
type ToggleProps = Omit<ComponentProps<'input'>, 'type' | 'role'>
export function Checkbox({ className = '', ...props }: ToggleProps) {
  return <input {...props} type="checkbox" className={`hy-checkbox ${className}`}/>
}
export function Switch({ className = '', ...props }: ToggleProps) {
  return <input {...props} type="checkbox" role="switch" className={`hy-switch ${className}`}/>
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export function Badge({ tone = 'neutral', className = '', ...props }: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return <span {...props} className={`hy-badge ${className}`} data-tone={tone}/>
}
export function Tag({ className = '', ...props }: ComponentProps<typeof Badge>) {
  return <Badge {...props} className={`hy-tag ${className}`}/>
}
