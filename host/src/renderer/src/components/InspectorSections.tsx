import { uiText } from '../../../shared/i18n/interface-display'
import { t, useLanguage } from '../language'
import { useUiDocument } from '../../../plugin-api/ui/widgets'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { UiHost } from '../plugin'
import { emptyInspectorLayout, inspectorLayoutKey, mergeInspectorOrder, moveInspectorSection, readInspectorLayout, type InspectorLayout } from '../inspector-layout'

export interface InspectorEntry { id: string; title: string; order: number; hint?: string; inactive?: boolean; actions?: ReactNode; content: ReactNode }
const dragType = 'application/x-rm-inspector-section'
/** 折叠仅隐藏正文，不卸载编辑器；排序保留 React key，输入和选择不会因移动被重建。 */
export function InspectorSections({ entries, host }: { entries: InspectorEntry[]; host: UiHost }) {
  useLanguage()
  const document = useUiDocument()
  const key = inspectorLayoutKey(host.root)
  const [layout, setLayout] = useState<InspectorLayout>(() => {
    try { return readInspectorLayout(localStorage.getItem(key)) } catch { return emptyInspectorLayout() }
  })
  const latest = useRef(layout), container = useRef<HTMLDivElement>(null)
  const dragging = useRef<string | undefined>(undefined)
  const [drop, setDrop] = useState<{ id: string; after: boolean }>()
  const prefix = useId()
  const defaults = [...entries].sort((a, b) => a.order - b.order).map(s => s.id)
  const order = mergeInspectorOrder(layout.order, defaults)
  const byId = new Map(entries.map(s => [s.id, s]))
  const visible = order.filter(id => byId.has(id) && (layout.showInactive || !byId.get(id)!.inactive))
  // 某些旧插件异步加载后返回 null；空分区不参与菜单或键盘移动的相邻项。
  const visibleNow = () => [...container.current?.querySelectorAll<HTMLElement>('[data-inspector-section]') ?? []]
    .filter(element => element.getClientRects().length > 0).map(element => element.dataset.inspectorSection!)
  const blur = () => {
    const active = document.activeElement as HTMLElement | null
    if (active && container.current?.contains(active)) active.blur()
  }
  const update = (change: (previous: InspectorLayout) => InspectorLayout) => {
    const next = change(latest.current)
    latest.current = next; setLayout(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { host.notify(uiText("详情布局仅在本次窗口中生效")) }
  }
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return
      const active = document.activeElement as HTMLElement | null
      if (active && container.current?.contains(active)) active.blur()
      const next = readInspectorLayout(event.newValue)
      latest.current = next; setLayout(next)
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }, [key, document])
  useUiEffect(display => {
    const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') { dragging.current = undefined; setDrop(undefined) } }
    display.onWindow('keydown', cancel)
  }, [])
  const fold = (id: string) => {
    blur()
    update(p => ({ ...p, collapsed: p.collapsed.includes(id) ? p.collapsed.filter(s => s !== id) : [...p.collapsed, id] }))
  }
  const move = (id: string, target: string, after = false) => {
    blur(); update(p => moveInspectorSection(p, defaults, id, target, after))
  }
  const menu = async (id: string) => {
    blur()
    const current = visibleNow(), index = current.indexOf(id)
    const action = await host.contextMenu([
      { id: 'fold', label: latest.current.collapsed.includes(id) ? t('section.open') : t('section.fold') },
      ...(index > 0 ? [{ id: 'top', label: t('section.top') }, { id: 'up', label: t('section.up') }] : []),
      ...(index < current.length - 1 ? [{ id: 'down', label: t('section.down') }, { id: 'bottom', label: t('section.bottom') }] : [])
    ])
    if (action === 'fold') fold(id)
    if (action === 'top') move(id, current[0])
    if (action === 'up') move(id, current[index - 1])
    if (action === 'down') move(id, current[index + 1], true)
    if (action === 'bottom') move(id, current.at(-1)!, true)
  }
  const layoutMenu = async () => {
    blur()
    const action = await host.contextMenu([
      { id: 'inactive', label: latest.current.showInactive ? t('section.hideInactive') : t('section.showInactive') },
      { type: 'separator' },
      { id: 'expand', label: t('section.openAll') }, { id: 'collapse', label: t('section.foldAll') },
      { type: 'separator' }, { id: 'reset', label: t('section.restore') }
    ])
    if (action === 'inactive') update(p => ({ ...p, showInactive: !p.showInactive }))
    if (action === 'expand') update(p => ({ ...p, collapsed: p.collapsed.filter(id => !visible.includes(id)) }))
    if (action === 'collapse') update(p => ({ ...p, collapsed: [...new Set([...p.collapsed, ...visible])] }))
    if (action === 'reset') update(emptyInspectorLayout)
  }
  const validDrag = (event: DragEvent) => !!dragging.current && visible.includes(dragging.current) && event.dataTransfer.types.includes(dragType)
  return <div className="inspector-sections" ref={container} onDragLeave={e => {
    if (!(e.relatedTarget as Node | null)?.nodeType || !e.currentTarget.contains(e.relatedTarget as Node)) setDrop(undefined)
  }}>
    <div className="inspector-layout-bar"><span>{t('workbench.sections')}</span><button title={t('workbench.sectionLayout')} aria-label={t('workbench.sectionLayout')} aria-haspopup="menu" onClick={() => void layoutMenu()}>{t('workbench.layoutButton')}</button></div>
    {visible.map(id => {
      const entry = byId.get(id)!, collapsed = layout.collapsed.includes(id)
      const bodyId = `${prefix}-${encodeURIComponent(id)}`
      return <section className={`section inspector-section${collapsed ? ' collapsed' : ''}${drop?.id === id ? drop.after ? ' drop-after' : ' drop-before' : ''}`} data-hy-part="inspector-section" data-inspector-section={id} key={id}
        onDragOver={e => {
          if (!validDrag(e)) return
          e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const after = e.clientY > rect.top + rect.height / 2
          if (dragging.current !== id) setDrop(old => old?.id === id && old.after === after ? old : { id, after })
          else setDrop(undefined)
          const scroll = container.current?.closest('.inspector')
          if (scroll) {
            const box = scroll.getBoundingClientRect()
            if (e.clientY < box.top + 40) scroll.scrollTop -= 16
            else if (e.clientY > box.bottom - 40) scroll.scrollTop += 16
          }
        }}
        onDrop={e => {
          if (!validDrag(e)) return
          e.preventDefault(); e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          move(dragging.current!, id, e.clientY > rect.top + rect.height / 2)
          dragging.current = undefined; setDrop(undefined)
        }}>
        <div className="inspector-section-head">
          <button className="inspector-section-grip" draggable aria-label={t('section.order', { name: entry.title })} title={t('section.orderHint')} onClick={() => void menu(id)}
            onDragStart={e => { blur(); dragging.current = id; e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(dragType, id) }}
            onDragEnd={e => { e.stopPropagation(); dragging.current = undefined; setDrop(undefined) }}
            onKeyDown={e => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault(); e.stopPropagation()
                const current = visibleNow()
                const target = current[current.indexOf(id) + (e.key === 'ArrowUp' ? -1 : 1)]
                if (target) move(id, target, e.key === 'ArrowDown')
                e.currentTarget.focus()
              }
            }}>⠿</button>
          <h3><button className="inspector-section-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => fold(id)}><span className="inspector-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span><span>{entry.title}</span></button></h3>
          {entry.actions && <div className="inspector-section-actions">{entry.actions}</div>}
          <button className="inspector-section-menu" aria-label={t('section.menuOf', { name: entry.title })} title={t('section.menu')} aria-haspopup="menu" onClick={() => void menu(id)}>···</button>
        </div>
        {entry.hint && <p className="inspector-section-hint muted">{entry.hint}</p>}
        <div id={bodyId} className="inspector-section-body" hidden={collapsed}>{entry.content}</div>
      </section>
    })}
  </div>
}
