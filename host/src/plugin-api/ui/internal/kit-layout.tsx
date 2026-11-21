import { useId, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from './kit-icons'

export interface KitOption { value: string; label: string; disabled?: boolean }
interface ChoiceProps {
  label: string
  value: string
  options: readonly KitOption[]
  onChange(value: string): void
}
function moveChoice(e: KeyboardEvent, options: readonly KitOption[], index: number, choose: (value: string) => void) {
  const available = options.filter(o => !o.disabled)
  if (!available.length) return
  const i = available.indexOf(options[index])
  let target: KitOption
  switch (e.key) {
    case 'Home': target = available[0]; break
    case 'End': target = available[available.length - 1]; break
    case 'ArrowLeft': target = available[(i - 1 + available.length) % available.length]; break
    case 'ArrowRight': target = available[(i + 1) % available.length]; break
    default: return
  }
  e.preventDefault(); e.stopPropagation()
  e.currentTarget.parentElement?.querySelectorAll('button')[options.indexOf(target)]?.focus()
  choose(target.value)
}
function Choices({ label, options, value, onChange, panel }: ChoiceProps & { panel?: string }) {
  const active = options.findIndex(o => o.value === value && !o.disabled)
  const tabStop = active < 0 ? options.findIndex(o => !o.disabled) : active
  return <div className={panel ? 'hy-tabs' : 'hy-segmented'} role={panel ? 'tablist' : 'radiogroup'} aria-label={label}>
    {options.map((o, i) => <button key={o.value} type="button" role={panel ? 'tab' : 'radio'} disabled={o.disabled}
      id={panel && `${panel}-tab-${i}`} aria-controls={panel && o.value === value ? panel : undefined}
      aria-selected={panel ? o.value === value : undefined} aria-checked={panel ? undefined : o.value === value}
      tabIndex={i === tabStop ? 0 : -1} onClick={() => onChange(o.value)} onKeyDown={e => moveChoice(e, options, i, onChange)}>{o.label}</button>)}
  </div>
}
export function SegmentedControl(props: ChoiceProps) { return <Choices {...props}/> }
export function Tabs({ children, ...props }: ChoiceProps & { children: ReactNode }) {
  const id = useId(), selected = props.options.findIndex(o => o.value === props.value)
  return <><Choices {...props} panel={id}/><div id={id} className="hy-tab-panel" role="tabpanel"
    aria-labelledby={selected >= 0 ? `${id}-tab-${selected}` : undefined} aria-label={selected < 0 ? props.label : undefined} tabIndex={0}>{children}</div></>
}
export function Toolbar({ label, start, children, end }: { label: string; start?: ReactNode; children?: ReactNode; end?: ReactNode }) {
  return <div className="hy-toolbar" role="group" aria-label={label}><div>{start}</div><div>{children}</div><div>{end}</div></div>
}
export function ToolbarSeparator() { return <span className="hy-toolbar-separator" aria-hidden="true"/> }

type RowProps = Omit<ComponentProps<'button'>, 'children' | 'title'> & {
  title: string; icon?: IconName; count?: number; actions?: ReactNode; selected?: boolean
}
export function ListRow({ title, icon, count, actions, selected, ...props }: RowProps) {
  return <div className="hy-list-row" data-selected={selected || undefined}>
    <button type="button" aria-current={selected || undefined} {...props}>{icon && <Icon name={icon}/>}<span>{title}</span>{count != null && <small>{count}</small>}</button>
    {actions}
  </div>
}
/** A disclosure row for nested navigation. Its toggle and optional actions are independent buttons. */
export function TreeRow({ depth = 0, expanded, onToggle, ...props }: RowProps & { depth?: number; expanded?: boolean; onToggle?(): void }) {
  return <div className="hy-tree-row" style={{ paddingInlineStart: Math.max(0, depth) * 14 }}>
    {onToggle && <button type="button" aria-label={`${expanded ? '收起' : '展开'}${props.title}`} aria-expanded={!!expanded} onClick={onToggle}><Icon name={expanded ? 'down' : 'right'}/></button>}
    <ListRow {...props}/>
  </div>
}
export function EmptyState({ title, description, icon, action }: { title: string; description?: ReactNode; icon?: IconName; action?: ReactNode }) {
  return <div className="hy-empty">{icon && <Icon name={icon} size={24}/>}<strong>{title}</strong>{description && <div>{description}</div>}{action}</div>
}
