import { cloneElement, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useUiDocument } from './document'
import { Button, IconButton } from './kit-controls'

type Anchor = HTMLElement | DOMRectReadOnly
type LayerProps = {
  anchor: Anchor
  align?: 'start' | 'end'
  onClose(): void
  children: ReactNode
} & Pick<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-label' | 'className' | 'id' | 'onKeyDown'>

/** A rect is a viewport snapshot (for context menus); an element follows scrolling/resizing. */
export function Popover({ anchor, align = 'start', onClose, children, className = '', ...props }: LayerProps) {
  const display = useUiDocument()
  const element = 'ownerDocument' in anchor ? anchor : null
  const doc = element?.ownerDocument ?? display
  const ref = useRef<HTMLDivElement>(null)
  const hint = props.role === 'tooltip'
  const container = (element ?? doc.activeElement)?.closest('dialog[open]') ?? doc.body
  useLayoutEffect(() => {
    const panel = ref.current!
    const win = doc.defaultView!
    // The native top layer provides light-dismiss, Escape, and nested picker behavior.
    if (element) panel.showPopover({ source: element })
    else panel.showPopover()
    const position = () => {
      if (element && (!element.isConnected || element.ownerDocument !== doc)) { panel.hidePopover(); return }
      const rect = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor
      const margin = 8, gap = 4
      const below = win.innerHeight - rect.bottom - gap - margin
      const above = rect.top - gap - margin
      const up = below < panel.scrollHeight + 2 && above > below
      panel.style.maxHeight = Math.max(1, up ? above : below) + 'px'
      const height = panel.offsetHeight, width = panel.offsetWidth
      // Chromium follows the implicit popover source even when a toolbar wraps without a resize.
      // Table menu contributions may instead supply a fixed viewport rectangle.
      const edge = (side: 'left' | 'right' | 'top' | 'bottom') => element ? `anchor(${side}, ${rect[side]}px)` : `${rect[side]}px`
      const x = align === 'start' ? edge('left') : `calc(${edge('right')} - ${width}px)`
      const y = up ? `calc(${edge('top')} - ${gap + height}px)` : `calc(${edge('bottom')} + ${gap}px)`
      panel.style.left = `clamp(${margin}px, ${x}, calc(100vw - ${width + margin}px))`
      panel.style.top = `clamp(${margin}px, ${y}, calc(100vh - ${height + margin}px))`
    }
    position()
    if (!hint) panel.querySelector<HTMLElement>('[data-hy-autofocus], [autofocus], input:not(:disabled), [role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const resize = new win.ResizeObserver(position)
    resize.observe(panel)
    if (element) resize.observe(element)
    const scroll = (e: Event) => {
      if (panel.contains(e.target as Node)) return
      if (element) position()
      else panel.hidePopover()
    }
    win.addEventListener('resize', position)
    doc.addEventListener('scroll', scroll, true)
    return () => {
      resize.disconnect()
      win.removeEventListener('resize', position)
      doc.removeEventListener('scroll', scroll, true)
      if (panel.matches(':popover-open')) panel.hidePopover()
    }
  }, [anchor, align, doc, element, hint, container])
  return createPortal(<div {...props} ref={ref} popover={hint ? 'hint' : 'auto'} className={`hy-popover ${className}`}
    onToggle={e => { if (e.newState === 'closed' && !e.currentTarget.matches(':popover-open')) onClose() }}
    onMouseDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    {children}
  </div>, container)
}

export interface MenuItem { id: string; label: string; disabled?: boolean; danger?: boolean; checked?: boolean }
export interface MenuGroup { label?: string; items: readonly MenuItem[] }
export function DropdownMenu({ anchor, label, groups, onSelect, onClose }: {
  anchor: HTMLElement; label: string; groups: readonly MenuGroup[]; onSelect(id: string): void; onClose(): void
}) {
  const keydown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = buttons.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
    if (e.key === 'Tab') { onClose(); anchor.focus(); return }
    if (!buttons.length) return
    let n: number
    switch (e.key) {
      case 'ArrowDown': n = (i + 1) % buttons.length; break
      case 'ArrowUp': n = (i - 1 + buttons.length) % buttons.length; break
      case 'Home': n = 0; break
      case 'End': n = buttons.length - 1; break
      default: return
    }
    e.preventDefault(); e.stopPropagation(); buttons[n].focus()
  }
  return <Popover role="menu" aria-label={label} className="hy-menu" anchor={anchor} onClose={onClose} onKeyDown={keydown}>
    {groups.map((group, index) => <div role="group" aria-label={group.label} key={group.items[0]?.id ?? index}>
      {group.label && <small>{group.label}</small>}
      {group.items.map(item => <button key={item.id} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={item.checked} tabIndex={-1} disabled={item.disabled} data-danger={item.danger || undefined}
        onClick={() => { onClose(); anchor.focus(); onSelect(item.id) }}>{item.label}{item.checked && <span aria-hidden="true">✓</span>}</button>)}
    </div>)}
  </Popover>
}

export function Dialog({ title, description, children, footer, onClose, busy = false }: {
  title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; onClose(): void; busy?: boolean
}) {
  const doc = useUiDocument(), id = useId(), ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [doc])
  return createPortal(<dialog className="hy-dialog" ref={ref} aria-labelledby={id} aria-describedby={description ? id + '-desc' : undefined}
    onCancel={e => { e.preventDefault(); if (!busy) onClose() }} onKeyDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); if (!busy && e.target === e.currentTarget) {
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose()
    } }}>
    <header><h2 id={id}>{title}</h2><IconButton icon="close" label="关闭" disabled={busy} onClick={onClose}/></header>
    {description && <p id={id + '-desc'}>{description}</p>}{children}{footer && <footer>{footer}</footer>}
  </dialog>, doc.body)
}
export function ConfirmDialog({ confirmLabel, onConfirm, danger, busy, onClose, ...props }: Omit<Parameters<typeof Dialog>[0], 'footer'> & {
  confirmLabel: string; onConfirm(): void; danger?: boolean
}) {
  return <Dialog {...props} busy={busy} onClose={onClose} footer={<>
    <Button autoFocus disabled={busy} onClick={onClose}>取消</Button>
    <Button loading={busy} variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
  </>}/>
}
export function Tooltip({ text, children }: { text: string; children: ReactElement<{ 'aria-describedby'?: string }> }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null), id = useId()
  return <span className="hy-tooltip-trigger" onPointerEnter={e => setAnchor(e.currentTarget)} onPointerLeave={e => { if (!e.currentTarget.matches(':focus-within')) setAnchor(null) }}
    onFocus={e => setAnchor(e.currentTarget)} onBlur={e => { if (!e.currentTarget.matches(':hover')) setAnchor(null) }}>
    {cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], anchor && id].filter(Boolean).join(' ') || undefined })}
    {anchor && <Popover anchor={anchor} role="tooltip" id={id} className="hy-tooltip" onClose={() => setAnchor(null)}>{text}</Popover>}
  </span>
}
