import { t, useLanguage } from '../language'
import { Select } from '../../../plugin-api/ui/kit'
import { useUiEffect } from '../../../plugin-api/ui/hooks'
import { UiPortal, useUiDocument } from '../../../plugin-api/ui/widgets'
import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { LayoutDef, UiHost } from '../plugin'
import { layoutSize, readBrowsingDefault, saveBrowsingDefault } from '../../../shared/browsing-layout'
import { CollectionLibraryContext, type useCollectionLayout } from '../use-collection-layout'
import { layoutList } from '../ui-registry'

export function LayoutPicker({ value, onChange }: { value: string; onChange(id: string): void }) {
  useLanguage()
  return <label className="layout-picker">{t('display.layout')}
    <Select aria-label={t('display.layout')} value={value} onChange={e => onChange(e.target.value)}>
      {!layoutList.some(l => l.id === value) && <option value={value}>{t('display.unavailable')}</option>}
      {layoutList.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
    </Select>
  </label>
}

/** 页面显示和保存视图共用插件选项；尺寸仍是本页状态，不混进保存视图规则。 */
export function LayoutOptions({ layout, options, setOptions, host }: { layout: LayoutDef; options: Record<string, unknown>; setOptions(options: Record<string, unknown>): void; host: UiHost }) {
  useLanguage()
  const Options = layout.Options
  return <>
    {layout.description && <p className="layout-description muted">{layout.description}</p>}
    {Options && <div className="layout-options"><Options key={layout.id} options={options} setOptions={setOptions} host={host} /></div>}
  </>
}

export function DisplayMenu({ display: d, host, active, savedViews }: { display: ReturnType<typeof useCollectionLayout>; host: UiHost; active: boolean; savedViews: boolean }) {
  useLanguage()
  const document = useUiDocument()
  const window = document.defaultView!
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId(), libraryId = useContext(CollectionLibraryContext)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 500 })
  const [preferred, setPreferred] = useState('')
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useUiEffect(display => {
    if (!open || !trigger.current || !panel.current) return
    const place = () => {
      const button = trigger.current!.getBoundingClientRect(), rect = panel.current!.getBoundingClientRect()
      const { innerHeight, innerWidth } = window
      const below = innerHeight - button.bottom - 18, above = button.top - 18
      const top = below >= Math.min(rect.height, 300) || below >= above ? button.bottom + 6 : Math.max(12, button.top - rect.height - 6)
      const next = { left: Math.max(12, Math.min(button.right - rect.width, innerWidth - rect.width - 12)), top, maxHeight: innerHeight - top - 12 }
      setPosition(old => old.left === next.left && old.top === next.top && old.maxHeight === next.maxHeight ? old : next)
    }
    place()
    panel.current.querySelector('select')?.focus()
    display.observeResize([trigger.current, panel.current], place)
    const toolbar = trigger.current.closest('.toolbar'), collection = trigger.current.closest('.collection')
    if (toolbar) display.observeResize(toolbar, place)
    if (collection) display.observeResize(collection, place)
    display.onWindow('resize', place)
  }, [open, document])
  const size = layoutSize(d.current)
  useUiEffect(display => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || panel.current?.querySelector('select:open')) return
      e.stopPropagation(); setOpen(false); trigger.current?.focus()
    }
    display.onDocument('mousedown', down)
    display.onWindow('keydown', key, true)
  }, [open, document])
  const changeDefault = (reset = false) => {
    try {
      saveBrowsingDefault(localStorage, libraryId, reset ? undefined : { layout: d.current.id, options: d.options, zoom: d.zoom })
      setPreferred(reset ? 'masonry' : d.current.id)
      host.notify(reset ? t('display.resetDefaultNotice') : t('display.savedDefault'))
    } catch (e) { host.notify(t('display.saveError', { error: String(e) })) }
  }
  return <div className="display-menu" ref={box}>
    <button ref={trigger} className={`small${open ? ' on' : ''}`} title={t('workbench.displayHint')} aria-label={t('workbench.displaySettings')} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" onClick={() => {
      if (!open) setPreferred(readBrowsingDefault(localStorage, libraryId).layout)
      setOpen(value => !value)
    }}>{t('workbench.display')} {d.current.title}{d.missing ? t('display.temporary') : ''} ▾</button>
    {open && <UiPortal><div ref={panel} style={position} className="display-panel" id={panelId} role="dialog" aria-label={t('workbench.displaySettings')} onKeyDown={e => e.stopPropagation()}>
      <LayoutPicker value={d.requested.layout} onChange={d.setLayout} />
      {d.missing && <p className="layout-description">{t('display.fallbackHint')}</p>}
      <LayoutOptions layout={d.current} options={d.options} setOptions={d.setOptions} host={host} />
      {size && <label className="display-size"><span>{size.label}<output>{d.zoom}</output></span>
        <input type="range" aria-label={size.label} min={size.min} max={size.max} step={size.step ?? 1} value={d.zoom} onChange={e => d.setZoom(Number(e.target.value))} />
      </label>}
      {(size || d.current.Options || d.current.defaultOptions) && <button className="small layout-reset" onClick={d.resetOptions}>{t('display.resetLayout')}</button>}
      <p className="layout-description muted">{t('display.hint')}{savedViews && <>{t('display.saveHint')}</>}</p>
      {libraryId && <div className="layout-default">
        <span>{t('display.default', { name: layoutList.find(l => l.id === preferred)?.title ?? t('workbench.unavailable', { name: preferred }) })}</span>
        <div><button className="small" disabled={d.missing} onClick={() => changeDefault()}>{t('display.setDefault')}</button>
          <button className="link" onClick={() => changeDefault(true)}>{t('display.clearDefault')}</button></div>
        <p className="muted">{t('display.defaultHint')}</p>
      </div>}
    </div></UiPortal>}
  </div>
}
